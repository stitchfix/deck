'use strict';

let angular = require('angular');

module.exports = angular.module('spinnaker.serverGroup.configure.titan.parameters.controller', [])
  .controller('titanServerGroupParametersCtrl', function($scope, v2modalWizardService) {

    v2modalWizardService.markComplete('parameters');
    v2modalWizardService.markClean('parameters');

    $scope.$watch('form.$valid', function(newVal) {
      if (newVal) {
        v2modalWizardService.markClean('parameters');
      } else {
        v2modalWizardService.markDirty('parameters');
      }
    });

  });
