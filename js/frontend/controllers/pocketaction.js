/**
 * @fileOverview PocketActionCtrl angular controller
 */
'use strict';

define(['./module', 'darkwallet', 'sjcl'], function (controllers, DarkWallet) {
  controllers.controller('PocketActionCtrl', ['$scope', 'modals', 'notify', '$history', '$location', function($scope, modals, notify, $history, $location) {

    /**
     * Delete pocket
     */
    $scope.deletePocket = function(pocket) {
        modals.open('confirm-delete', {name: pocket.name, object: pocket}, $scope.deletePocketFinish)
    };

    /**
     * Rename a pocket
     */
    $scope.renamePocket = function(pocket) {
        // continues in PocketCreateCtrl
        $scope.forms.pocketName = pocket.name;
        $scope.renamingPocket = true;
    };

    /**
     * Finalize Rename a pocket
     */
    $scope.finalizeRenamePocket = function(pocket, name) {
        if (!pocket || !name || pocket.name === name) {
            // if empty just toggle visibility
        } else {
            var identity = DarkWallet.getIdentity();
            var walletPocket = identity.wallet.pockets.getPocket($history.pocket.index, $history.pocket.type);
            if (walletPocket.type === 'readonly') {
                // Disable watch also if deleting a watch pocket
                var contact = identity.contacts.search({name: walletPocket.name});
                if (contact && contact.data.watch) {
                    contact.data.name = name;
                    watch.renamePocket(name, walletPocket.name);
                    // update frontend index
                    $scope.updateReadOnly(identity);
                }
            } else if (walletPocket.type === 'multisig') {
                walletPocket.name = name;
                walletPocket.fund.name = name;
            } else {
                // Otherwise just change the name
                walletPocket.name = name;
                walletPocket.store.name = name;
            }
            identity.store.save();
            $scope.pocket.name = name;
        }
        $scope.forms.pocketName = '';
        $scope.renamingPocket = false;
    };


    /**
     * Really delete a pocket after confirmation
     */
    $scope.deletePocketFinish = function(pocket) {
        var identity = DarkWallet.getIdentity();
        var oldPocket = $history.removePocket(pocket.type, pocket.index);
        if (oldPocket.type === 'readonly') {
            var contact = identity.contacts.search({name: oldPocket.name});
            if (contact && contact.data.watch) {
                contact.data.watch = false;
            }
            $scope.updateReadOnly(identity);
        }
        $location.path('/wallet');
    };

    /**
     * Toggle the pocket's mixing state
     */
    $scope.setMixing = function(pocket) {
        var identity = DarkWallet.getIdentity();
        var walletPocket = identity.wallet.pockets.getPocket(pocket.index, 'hd').store;
        // Finish setting mixing in the pocket
        // this can happen after requesting the password
        var finishSetMixing = function() {
            walletPocket.mixing = !walletPocket.mixing;
            pocket.mixing = walletPocket.mixing;
            // mixing options
            if (pocket.mixing && !walletPocket.mixingOptions) {
                walletPocket.mixingOptions = {budget: 100000, spent: 0, mixings: 5};
                pocket.mixingOptions = walletPocket.mixingOptions;
            }
            // save store
            identity.wallet.store.save();
            var mixerService = DarkWallet.service.mixer;
            mixerService.checkMixing();
        }

        // We're going to enable mixing so request the password to gather the key for the pocket
        if (!walletPocket.mixing) {
            modals.password('Write the password for your pocket', function(password) {
                var safe = DarkWallet.service.safe;
                // get master private for the pockets since the mixer will need them
                try {
                    var privKey = identity.wallet.getPocketPrivate(pocket.index*2, password);
                } catch(e) {
                    if ($scope.settings.advanced) {
                        notify.warning("Invalid password", e.message || ""+e)
                    } else {
                        notify.warning("Invalid Password")
                    }
                    return;
                }
                var changeKey = identity.wallet.getPocketPrivate((pocket.index*2)+1, password);

                // Save some session passwords for the mixer
                var pocketPassword = safe.set('mixer', 'pocket:'+pocket.index, password);

                // Save the keys encrypted with the pocket
                walletPocket.privKey = sjcl.encrypt(pocketPassword, privKey, {ks: 256, ts: 128});
                walletPocket.privChangeKey = sjcl.encrypt(pocketPassword, changeKey, {ks: 256, ts: 128});

                // Finish setting the pocket mixing state
                finishSetMixing();
            });
        } else {
            // Otherwise ensure we delete any private data from the pocket
            walletPocket.privKey = undefined;
            walletPocket.privChangeKey = undefined;
            finishSetMixing();
        }
    };

    /**
     * Update the form with mixing options
     */
    var updateMixingOptions = function(pocket) {
        if (!$scope.forms.mixingOptions) {
            $scope.forms.mixingOptions = {};
        }
        if (!pocket.mixingOptions) {
            return;
        }
        Object.keys(pocket.mixingOptions).forEach(function(name) {
            $scope.forms.mixingOptions[name] = pocket.mixingOptions[name];
        });
    };

    /**
     * Set mixing options
     */
    $scope.setMixingOptions = function(pocket, options) {
        var identity = DarkWallet.getIdentity();
        var walletPocket = identity.wallet.pockets.getPocket(pocket.index, 'hd').store;

        // now set options
        walletPocket.mixingOptions.budget = parseInt(options.budget);
        walletPocket.mixingOptions.mixings = parseInt(options.mixings);

        // save
        identity.wallet.store.save();
    };

    // Watch pocket change to update the form
    $scope.$watch('pocket.mixingOptions', function() {
        updateMixingOptions($scope.pocket);
    });


    /**
     * Move funds to another pocket or identity
     */
    $scope.moveFunds = function(type, index) {
        var identity = DarkWallet.getIdentity();
        var wallet = identity.wallet;
        var to;
        var address;
        if (type === 'pocket') {
            type = 'hd';
        }
        // generate a destination address
        var pocket = wallet.pockets.getPocket(index, type);
        if (pocket) {
            to = pocket.name;
            address = pocket.getFreeAddress().address;
        } else {
            throw Error('Invalid type while moving funds!');
        }

        // Prepare transaction

        var fee = wallet.fee;
        var amount = $scope.pocket.balance.confirmed - fee;

        var recipients = [{amount: amount, address: address}];
        var metadata = identity.tx.prepare($scope.pocket.index, recipients, null, fee);
 
        // Request password for signing
        var message = "Are you sure you want to move all ";
        message += $scope.pocket.name + " funds to " + to + "?";
        modals.password(message, function(password) {
           // Sign and broadcast
           var walletService = DarkWallet.service.wallet;
           var sent = false;
           walletService.signTransaction(metadata.tx, metadata, password, function(err, count) {
               if (err) {
                   notify.error(err.message || ""+err);
               }
               if (count>0.2 && !sent) {
                   sent = true;
                   notify.success('Funds sent to ' + to);
                   if (!$scope.$$phase) {
                       $scope.apply();
                   }
               }
               console.log("broadcast", count);
           }, true);
        });
    };

}]);
});
