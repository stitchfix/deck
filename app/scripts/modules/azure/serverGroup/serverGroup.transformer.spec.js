'use strict';

describe('azureServerGroupTransformer', function () {

  var transformer, $scope;

  beforeEach(
    window.module(
      require('./serverGroup.transformer.js')
    )
  );

  beforeEach(function () {
    window.inject(function (_azureServerGroupTransformer_, $rootScope) {
      transformer = _azureServerGroupTransformer_;
      $scope = $rootScope.$new();
    });
  });

  describe('command transforms', function () {

    it('sets name correctly with no stack or detail', function () {
      var base = {
        application: 'myApp',
        sku:{
          capacity: 1,
        },
        selectedImage:{
          publisher: 'Microsoft',
          offer: 'Windows',
          sku: 'Server2016',
          version: '12.0.0.1',
        },
        viewState: {
          mode: 'create',
        }
      };

      var transformed = transformer.convertServerGroupCommandToDeployConfiguration(base);

      expect(transformed.name).toBe('myApp');

    });

    it('it sets name correctly with only stack', function () {
      var command = {
        stack: 's1',
        application: 'theApp',
        sku:{
          capacity: 1,
        },
        selectedImage:{
          publisher: 'Microsoft',
          offer: 'Windows',
          sku: 'Server2016',
          version: '12.0.0.1',
        },
        viewState: {
          mode: 'create',
        }
      };

      var transformed = transformer.convertServerGroupCommandToDeployConfiguration(command);

      expect(transformed.name).toBe('theApp-s1');
    });

    it('it sets name correctly with only detail', function () {
      var command = {
        details: 'd1',
        application: 'theApp',
        sku:{
          capacity: 1,
        },
        selectedImage:{
          publisher: 'Microsoft',
          offer: 'Windows',
          sku: 'Server2016',
          version: '12.0.0.1',
        },
        viewState: {
          mode: 'create',
        }
      };

      var transformed = transformer.convertServerGroupCommandToDeployConfiguration(command);

      expect(transformed.name).toBe('theApp-d1');
    });

    it('it sets name correctly with both stack and detail', function () {
      var command = {
        stack: 's1',
        details: 'd1',
        application: 'theApp',
        sku:{
          capacity: 1,
        },
        selectedImage:{
          publisher: 'Microsoft',
          offer: 'Windows',
          sku: 'Server2016',
          version: '12.0.0.1',
        },
        viewState: {
          mode: 'create',
        }
      };

      var transformed = transformer.convertServerGroupCommandToDeployConfiguration(command);

      expect(transformed.name).toBe('theApp-s1-d1');
    });

  });
});
