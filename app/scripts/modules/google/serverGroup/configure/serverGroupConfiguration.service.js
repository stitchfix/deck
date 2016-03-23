'use strict';

let angular = require('angular');

module.exports = angular.module('spinnaker.serverGroup.configure.gce.configuration.service', [
  require('../../../core/account/account.service.js'),
  require('../../../core/securityGroup/securityGroup.read.service.js'),
  require('../../../core/cache/cacheInitializer.js'),
  require('../../../core/loadBalancer/loadBalancer.read.service.js'),
  require('../../../core/network/network.read.service.js'),
  require('../../../core/subnet/subnet.read.service.js'),
  require('../../image/image.reader.js'),
  require('../../instance/gceInstanceType.service.js'),
])
  .factory('gceServerGroupConfigurationService', function(gceImageReader, accountService, securityGroupReader,
                                                          gceInstanceTypeService, cacheInitializer,
                                                          $q, loadBalancerReader, networkReader, subnetReader, _) {

    var persistentDiskTypes = [
      'pd-standard',
      'pd-ssd'
    ];
    var authScopes = [
      'cloud-platform',
      'userinfo.email',
      'compute.readonly',
      'compute',
      'cloud.useraccounts.readonly',
      'cloud.useraccounts',
      'devstorage.read_only',
      'devstorage.write_only',
      'devstorage.full_control',
      'taskqueue',
      'bigquery',
      'sqlservice.admin',
      'datastore',
      'logging.write',
      'logging.read',
      'logging.admin',
      'monitoring.write',
      'monitoring.read',
      'monitoring',
      'bigtable.data.readonly',
      'bigtable.data',
      'bigtable.admin',
      'bigtable.admin.table',
    ];

    function configureCommand(application, command) {
      var imageLoader;
      if (command.viewState.disableImageSelection) {
        imageLoader = $q.when(null);
      } else {
        imageLoader = command.viewState.imageId ? loadImagesFromImageName(command) : loadImagesFromApplicationName(application, command.selectedProvider);
      }

      return $q.all({
        credentialsKeyedByAccount: accountService.getCredentialsKeyedByAccount('gce'),
        securityGroups: securityGroupReader.getAllSecurityGroups(),
        networks: networkReader.listNetworksByProvider('gce'),
        subnets: subnetReader.listSubnetsByProvider('gce'),
        loadBalancers: loadBalancerReader.listLoadBalancers('gce'),
        packageImages: imageLoader,
        instanceTypes: gceInstanceTypeService.getAllTypesByRegion(),
        persistentDiskTypes: $q.when(angular.copy(persistentDiskTypes)),
        authScopes: $q.when(angular.copy(authScopes)),
      }).then(function(backingData) {
        var loadBalancerReloader = $q.when(null);
        var securityGroupReloader = $q.when(null);
        var networkReloader = $q.when(null);
        backingData.accounts = _.keys(backingData.credentialsKeyedByAccount);
        backingData.filtered = {};
        command.backingData = backingData;
        configureImages(command);

        if (command.loadBalancers && command.loadBalancers.length) {
          // Verify all load balancers are accounted for; otherwise, try refreshing load balancers cache.
          var loadBalancerNames = getLoadBalancerNames(command);
          if (_.intersection(loadBalancerNames, command.loadBalancers).length < command.loadBalancers.length) {
            loadBalancerReloader = refreshLoadBalancers(command, true);
          }
        }
        if (command.securityGroups && command.securityGroups.length) {
          // Verify all security groups are accounted for; otherwise, try refreshing security groups cache.
          var securityGroupIds = _.pluck(getSecurityGroups(command), 'id');
          if (_.intersection(command.securityGroups, securityGroupIds).length < command.securityGroups.length) {
            securityGroupReloader = refreshSecurityGroups(command, true);
          }
        }
        if (command.network) {
          // Verify network is accounted for; otherwise, try refreshing networks cache.
          var networkNames = getNetworkNames(command);
          if (networkNames.indexOf(command.network) === -1) {
            networkReloader = refreshNetworks(command);
          }
        }

        return $q.all([loadBalancerReloader, securityGroupReloader, networkReloader]).then(function() {
          attachEventHandlers(command);
        });
      });
    }

    function loadImagesFromApplicationName(application, provider) {
      return gceImageReader.findImages({
        provider: provider,
        q: application.name.replace(/_/g, '[_\\-]') + '*',
      });
    }

    function loadImagesFromImageName(command) {
      command.image = command.viewState.imageId;

      var packageBase = command.image.split('_')[0];
      var parts = packageBase.split('-');
      if (parts.length > 3) {
        packageBase = parts.slice(0, -3).join('-');
      }
      if (!packageBase || packageBase.length < 3) {
        return [command.image];
      }

      return gceImageReader.findImages({
        provider: command.selectedProvider,
        q: packageBase + '-*',
      });
    }

    function configureInstanceTypes(command) {
      var result = { dirty: {} };
      if (command.region) {
        var filtered = gceInstanceTypeService.getAvailableTypesForRegions(command.backingData.instanceTypes, [command.region]);
        filtered = sortInstanceTypes(filtered);
        if (command.instanceType && filtered.indexOf(command.instanceType) === -1) {
          command.instanceType = null;
          result.dirty.instanceType = true;
        }
        command.backingData.filtered.instanceTypes = filtered;
      } else {
        command.backingData.filtered.instanceTypes = [];
      }
      return result;
    }

    // n1-standard-8 should come before n1-standard-16, so we must sort by the individual segments of the names.
    function sortInstanceTypes(instanceTypes) {
      var tokenizedInstanceTypes = _.map(instanceTypes, instanceType => {
        let tokens = instanceType.split('-');

        return {
          class: tokens[0],
          group: tokens[1],
          index: Number(tokens[2]) || 0
        };
      });

      let sortedTokenizedInstanceTypes = _.sortByAll(tokenizedInstanceTypes, ['class', 'group', 'index']);

      return _.map(sortedTokenizedInstanceTypes, sortedTokenizedInstanceType => {
        return sortedTokenizedInstanceType.class + '-' + sortedTokenizedInstanceType.group + (sortedTokenizedInstanceType.index ? '-' + sortedTokenizedInstanceType.index : '');
      });
    }

    function configureImages(command) {
      var result = { dirty: {} };
      if (command.viewState.disableImageSelection) {
        return result;
      }
      if (command.credentials !== command.viewState.lastImageAccount) {
        command.viewState.lastImageAccount = command.credentials;
        var filteredImages = extractFilteredImages(command);
        command.backingData.filtered.images = filteredImages;
        if (!_(filteredImages).find({imageName: command.image})) {
          command.image = null;
          result.dirty.imageName = true;
        }
      }
      return result;
    }

    function configureZones(command) {
      var result = { dirty: {} };
      var filteredData = command.backingData.filtered;
      if (command.region === null) {
        return result;
      }
      filteredData.zones =
        command.backingData.credentialsKeyedByAccount[command.credentials].regions[command.region];
      if (!_(filteredData.zones).contains(command.zone)) {
        command.zone = '';
        result.dirty.zone = true;
      }
      return result;
    }

    function getLoadBalancerNames(command) {
      return _(command.backingData.loadBalancers)
        .pluck('accounts')
        .flatten(true)
        .filter({name: command.credentials})
        .pluck('regions')
        .flatten(true)
        .filter({name: command.region})
        .pluck('loadBalancers')
        .flatten(true)
        .pluck('name')
        .unique()
        .valueOf();
    }

    function configureLoadBalancerOptions(command) {
      var results = { dirty: {} };
      var current = command.loadBalancers;
      var newLoadBalancers = getLoadBalancerNames(command);

      if (current && command.loadBalancers) {
        var matched = _.intersection(newLoadBalancers, command.loadBalancers);
        var removed = _.xor(matched, current);
        command.loadBalancers = matched;
        if (removed.length) {
          results.dirty.loadBalancers = removed;
        }
      }
      command.backingData.filtered.loadBalancers = newLoadBalancers;
      return results;
    }

    function extractFilteredImages(command) {
      return _(command.backingData.packageImages)
        .filter({account: command.credentials})
        .unique()
        .valueOf();
    }

    function refreshLoadBalancers(command, skipCommandReconfiguration) {
      return cacheInitializer.refreshCache('loadBalancers').then(function() {
        return loadBalancerReader.listLoadBalancers('gce').then(function(loadBalancers) {
          command.backingData.loadBalancers = loadBalancers;
          if (!skipCommandReconfiguration) {
            configureLoadBalancerOptions(command);
          }
        });
      });
    }

    function configureSubnets(command) {
      var result = { dirty: {} };
      var filteredData = command.backingData.filtered;
      if (command.region === null) {
        return result;
      }
      filteredData.subnets = _(command.backingData.subnets)
        .filter({ account: command.credentials, network: command.network, region: command.region })
        .pluck('name')
        .valueOf();

      if (!_(filteredData.subnets).contains(command.subnet)) {
        command.subnet = '';
        result.dirty.subnet = true;
      }
      return result;
    }

    function getSecurityGroups(command) {
      var newSecurityGroups = command.backingData.securityGroups[command.credentials] || { gce: {}};
      newSecurityGroups = _.filter(newSecurityGroups.gce.global, function(securityGroup) {
        return securityGroup.network === command.network;
      });
      return _(newSecurityGroups)
        .sortBy('name')
        .valueOf();
    }

    function configureSecurityGroupOptions(command) {
      var results = { dirty: {} };
      var currentOptions = command.backingData.filtered.securityGroups;
      var newSecurityGroups = getSecurityGroups(command);
      if (currentOptions && command.securityGroups) {
        // not initializing - we are actually changing groups
        var currentGroupNames = command.securityGroups.map(function(groupId) {
          var match = _(currentOptions).find({id: groupId});
          return match ? match.name : groupId;
        });

        var matchedGroups = command.securityGroups.map(function(groupId) {
          var securityGroup = _(currentOptions).find({id: groupId}) ||
              _(currentOptions).find({name: groupId});
          return securityGroup ? securityGroup.name : null;
        }).map(function(groupName) {
          return _(newSecurityGroups).find({name: groupName});
        }).filter(function(group) {
          return group;
        });

        var matchedGroupNames = _.pluck(matchedGroups, 'name');
        var removed = _.xor(currentGroupNames, matchedGroupNames);
        command.securityGroups = _.pluck(matchedGroups, 'id');
        if (removed.length) {
          results.dirty.securityGroups = removed;
        }
      }

      // Only include explicit security group options in the pulldown list.
      command.backingData.filtered.securityGroups = _.filter(newSecurityGroups, function(securityGroup) {
        return !_.isEmpty(securityGroup.targetTags);
      });

      // Identify implicit security groups so they can be optionally listed in a read-only state.
      command.implicitSecurityGroups = _.filter(newSecurityGroups, function(securityGroup) {
        return _.isEmpty(securityGroup.targetTags);
      });

      // Only include explicitly-selected security groups in the body of the command.
      command.securityGroups = _.difference(command.securityGroups, _.pluck(command.implicitSecurityGroups, 'id'));

      return results;
    }

    function refreshSecurityGroups(command, skipCommandReconfiguration) {
      return cacheInitializer.refreshCache('securityGroups').then(function() {
        return securityGroupReader.getAllSecurityGroups().then(function(securityGroups) {
          command.backingData.securityGroups = securityGroups;
          if (!skipCommandReconfiguration) {
            configureSecurityGroupOptions(command);
          }
        });
      });
    }

    function getNetworkNames(command) {
      return _.pluck(_.filter(command.backingData.networks, { account: command.credentials }), 'name');
    }

    function refreshNetworks(command) {
      networkReader.listNetworksByProvider('gce').then(function(gceNetworks) {
        command.backingData.networks = gceNetworks;
      });
    }

    function refreshInstanceTypes(command) {
      return cacheInitializer.refreshCache('instanceTypes').then(function() {
        return gceInstanceTypeService.getAllTypesByRegion().then(function(instanceTypes) {
          command.backingData.instanceTypes = instanceTypes;
          configureInstanceTypes(command);
        });
      });
    }

    function attachEventHandlers(command) {

      command.regionChanged = function regionChanged() {
        var result = { dirty: {} };
        var filteredData = command.backingData.filtered;
        angular.extend(result.dirty, configureSubnets(command).dirty);
        if (command.region) {
          angular.extend(result.dirty, configureInstanceTypes(command).dirty);
          angular.extend(result.dirty, configureZones(command).dirty);
          angular.extend(result.dirty, configureLoadBalancerOptions(command).dirty);
          angular.extend(result.dirty, configureImages(command).dirty);
        } else {
          filteredData.zones = null;
        }

        command.viewState.dirty = command.viewState.dirty || {};
        angular.extend(command.viewState.dirty, result.dirty);
        return result;
      };

      command.credentialsChanged = function credentialsChanged() {
        var result = { dirty: {} };
        var backingData = command.backingData;
        if (command.credentials) {
          backingData.filtered.regions = Object.keys(backingData.credentialsKeyedByAccount[command.credentials].regions);
          if (backingData.filtered.regions.indexOf(command.region) === -1) {
            command.region = null;
            result.dirty.region = true;
          } else {
            angular.extend(result.dirty, command.regionChanged().dirty);
          }

          backingData.filtered.networks = getNetworkNames(command);
          if (backingData.filtered.networks.indexOf(command.network) === -1) {
            command.network = null;
            result.dirty.network = true;
          } else {
            angular.extend(result.dirty, command.networkChanged().dirty);
          }
        } else {
          command.region = null;
        }

        command.viewState.dirty = command.viewState.dirty || {};
        angular.extend(command.viewState.dirty, result.dirty);

        return result;
      };

      command.networkChanged = function networkChanged() {
        var result = { dirty: {} };

        command.viewState.autoCreateSubnets = _(command.backingData.networks)
          .filter({ account: command.credentials, name: command.network })
          .pluck('autoCreateSubnets')
          .head();

        command.viewState.subnets = _(command.backingData.networks)
          .filter({ account: command.credentials, name: command.network })
          .pluck('subnets')
          .head();

        angular.extend(result.dirty, configureSubnets(command).dirty);
        angular.extend(result.dirty, configureSecurityGroupOptions(command).dirty);

        command.viewState.dirty = command.viewState.dirty || {};
        angular.extend(command.viewState.dirty, result.dirty);

        return result;
      };
    }

    return {
      configureCommand: configureCommand,
      configureInstanceTypes: configureInstanceTypes,
      configureImages: configureImages,
      configureZones: configureZones,
      configureSubnets: configureSubnets,
      configureLoadBalancerOptions: configureLoadBalancerOptions,
      refreshLoadBalancers: refreshLoadBalancers,
      refreshSecurityGroups: refreshSecurityGroups,
      refreshInstanceTypes: refreshInstanceTypes,
    };


  });
