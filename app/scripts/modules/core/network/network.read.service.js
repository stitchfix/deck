'use strict';

import {API_SERVICE} from 'core/api/api.service';

let angular = require('angular');

module.exports = angular
  .module('spinnaker.core.network.read.service', [
    require('../cache/infrastructureCaches.js'),
    API_SERVICE
  ])
  .factory('networkReader', function (API, infrastructureCaches ) {

    function listNetworks() {
      return API.one('networks')
        .useCache(infrastructureCaches.networks)
        .get();
    }

    function listNetworksByProvider(cloudProvider) {
      return API.one('networks').one(cloudProvider)
        .useCache(infrastructureCaches.networks)
        .getList();
    }

    return {
      listNetworks: listNetworks,
      listNetworksByProvider: listNetworksByProvider,
    };
  });
