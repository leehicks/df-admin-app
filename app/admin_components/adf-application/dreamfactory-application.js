'use strict';


angular.module('dfApplication', ['dfUtility', 'dfUserManagement', 'ngResource', 'ngProgress'])

    .factory('httpRequestInterceptor', function () {
        return {
            request: function (config) {

                config.headers['X-UA-Compatible'] = 'IE=Edge';

                return config;
            }
        };
    })

    .config(function ($httpProvider) {
        $httpProvider.interceptors.push('httpRequestInterceptor');
    })

    .run(['$q', 'dfApplicationData', 'dfApplicationPrefs', 'dfSessionStorage', 'UserDataService', 'SystemConfigDataService', '$location', '$rootScope', 'ngProgressFactory',
        function ($q, dfApplicationData, dfApplicationPrefs, dfSessionStorage, UserDataService, SystemConfigDataService, $location, $rootScope, ngProgressFactory) {

        var SystemConfig;
        $rootScope.progressbar = ngProgressFactory.createInstance();

        dfApplicationData.loadApiData(['system/environment'], true).then(
            function (response) {
                SystemConfig = response[0];
                SystemConfigDataService.setSystemConfig(SystemConfig);
                // if no local dfApplicationObject and there is a current user
                // **possibly a closed tab without loggin out**
                if (!dfSessionStorage.getItem('dfApplicationObj') && UserDataService.getCurrentUser()) {

                    // Set init var true so other modules can check state
                    dfApplicationData.initInProgress = true;

                    // Set a rootScope init var.  The httpValidSession service looks for this to
                    // determine if it should show the popup login on api call failure
                    $rootScope.initInProgress = true;

                    // Set a promise object so that any modules loading can be alerted to
                    // the init completion
                    dfApplicationData.initDeferred = $q.defer();

                    dfApplicationData.init().then(
                        // Success
                        function () {

                            // Resolve the init promise which will allow modules waiting on the init processs
                            // to finish loading.  You will find this resolution in the resolve function
                            // of component modules(like dfApps, dfUsers, dfRoles, etc etc)
                            dfApplicationData.initDeferred.resolve();

                            // Set our init flag to false
                            dfApplicationData.initInProgress = false;
                        },
                        // Error
                        function () {

                            dfApplicationData.initInProgress = false;
                            $location.url('/logout');
                        }
                    )
                }

                // if we have a dfApplicationObj and a current user
                // ** browser refresh **
                else if (dfSessionStorage.getItem('dfApplicationObj') && UserDataService.getCurrentUser()) {


                    // same init process as above.
                    dfApplicationData.initInProgress = true;
                    $rootScope.initInProgress = true;
                    dfApplicationData.initDeferred = $q.defer();

                    // reload app data
                    dfApplicationData.init().then(
                        function () {
                            dfApplicationData.initDeferred.resolve();
                            dfApplicationData.initInProgress = false;
                        },
                        function () {
                            dfApplicationData.initInProgress = false;
                            $location.url('/logout');
                            return;
                        }
                    )
                }

                // No local dfApplicationObj and no current user
                else if (!dfSessionStorage.getItem('dfApplicationObj') && !UserDataService.getCurrentUser()) {

                    // Destroy any existing dfApplicationObj that may be in memory
                    dfApplicationData.destroyApplicationObj();

                    // redirect to login
                    // the application routing will take care of this automatically

                }
                else if (dfSessionStorage.getItem('dfApplicationObj') && !UserDataService.getCurrentUser()) {

                    // Something went wrong.  App obj should not be present
                    // This should be ammedned to accept guest users as a possibility
                    dfSessionStorage.removeItem('dfApplicationObj');

                    // Delete the dfApplicationObj if it is in memory
                    dfApplicationData.destroyApplicationObj();

                    // send to login
                    $location.url('/login');
                }
                else {

                    // Sample Caching Mode
                    // used for development so we don't have to contact the sever
                    // everytime we make a CSS change.  Commented out as nothing should ever reach here.
                    // screen was refreshed.  reload app obj from session storage
                    // dfApplicationData.setApplicationObj(angular.fromJson(dfSessionStorage.getItem('dfApplicationObj')));
                    alert('dfAplicationData: INIT: This should not be reached')
                }

        });
    }])

    .service('dfApplicationData', ['$q', '$http', 'INSTANCE_URL', 'dfObjectService', 'UserDataService', 'dfSystemData', 'dfSessionStorage', 'dfApplicationPrefs', '$rootScope', '$location', 'dfMainLoading', function ($q, $http, INSTANCE_URL, dfObjectService, UserDataService, dfSystemData, dfSessionStorage, dfApplicationPrefs, $rootScope, $location, dfMainLoading) {


        var dfApplicationObj = {
            currentUser: null,
            apis: {},
            newApis: {}
        };

        var dfMainLoadData = {
            numElemsToLoad: 0,
            percentLoaded: 0,
            loadData: {

                op: 'Loading',
                module: null,
                percent: 0
            }
        };

        // remove params with null values
        function _checkParams(options) {

            if (!options.params) {
                options['params'] = {};
                return;
            }
            angular.forEach(options.params, function (value, key) {

                if (value == null) {
                    delete options.params[key];
                }
            });
        }

        function _fetchFromApi(apiName) {
            var api = {
                api_name: apiName,
                params: {}
            };

            var _prefs = _getAdminPrefs();

            if (_prefs.valid) {

                api.params = _prefs.settings.data[apiName];
            }

            // check for and remove null value params
            _checkParams(api);

            // This is a special case and could be handled better
            // do we just want a list of system components
            if (api.api_name === 'system') {

                // set the name to empty string because already build the
                // url with 'system' in it.
                api.api_name = '';
            }

            return dfSystemData.getSystemApisFromServer(api).then(
                function (result) {

                    switch (apiName) {

                        case 'system':

                            // Set our application object system prop
                            dfApplicationObj['apis']['system'] = {};
                            dfApplicationObj.apis.system['resource'] = result.data.resource;

                            break;

                        case 'config':

                            // Set our application object config prop
                            dfApplicationObj['apis']['config'] = {};

                            // This returns an object so store in an array to mimick other apis
                            dfApplicationObj.apis.config['resource'] = new Array(result.data);

                            break;

                        default:

                            dfApplicationObj['apis'][apiName] = result.data;
                    }

                    // Set the loading screen
                    // dfMainLoading.update(apiName);
                    $rootScope.$broadcast(apiName);
                },
                $q.reject
            );
        }

        function _loadApiData(apis, forceRefresh) {

            var deferred = $q.defer();
            var promises = apis.map(function(api) {
                return _loadOne(api, forceRefresh);
            });
            $q.all(promises).then(
                function (response) {
                    deferred.resolve(response);
                },
                function (response) {
                    deferred.reject(response);
                }
            );
            return deferred.promise;
        }

        function _loadOne(api, forceRefresh) {

            var verbose = true;
            var deferred = $q.defer();

            var url = INSTANCE_URL + '/api/v2/' + api;

            if (forceRefresh !== true && dfApplicationObj.newApis.hasOwnProperty(api)) {
                if (verbose) console.log('_loadOne: from cache', dfApplicationObj.newApis[api]);
                deferred.resolve(dfApplicationObj.newApis[api]);
            } else {
                $http.get(url)
                    .then(function (response) {
                        if (verbose) console.log('_loadOne: ok from server', response.data);
                        dfApplicationObj.newApis[api] = response.data.resource || response.data;
                        dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true));
                        deferred.resolve(dfApplicationObj.newApis[api]);
                    }, function (error) {
                        if (verbose) console.log('_loadOne: error from server', error.data);
                        deferred.reject(error.data);
                    });
            }

            return deferred.promise;
        }

        // Loads modules data and builds application object from async calls
        function _asyncInit(apis) {

            var defer = $q.defer();

            // Load our current user into the application obj
            dfApplicationObj.currentUser = UserDataService.getCurrentUser();

            // Are we an admin
            if (dfApplicationObj.currentUser.is_sys_admin) {

                var _prefsValid = _getAdminPrefs();

                if (!_prefsValid.valid && !_prefsValid.settings) {
                    _getAdminPrefs();
                }

                var promises = apis.map(_fetchFromApi);

                $q.all(promises).then(
                    function () {

                        // Set our bootstrapped application object into sessionStorage
                        dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true));

                        defer.resolve();

                        // Init was successful.  The popup login will check for this value to be false before
                        // showing.  Init is in progress it will allow this module to handle login/logout and user location
                        $rootScope.initInProgress = false;
                    },
                    defer.reject
                );


                //return defer.promise;
            } else {
                // current user is not admin so just call resolve for defer
                defer.resolve();
            }

            return defer.promise;
        }

        // Resets the dfApplicationObj to initial state
        function _resetApplicationObj() {

            dfApplicationObj = {
                currentUser: null,
                apis: {},
                newApis: {}
            };
        }

        // Save api data to server
        function _saveApiData(api, options) {

            // check for and remove null value params
            _checkParams(options);

            // set up our params
            var params = options.params;
            params['api'] = api;

            if (!options.dontWrapData) {
                // add wrapper
                options.data = {"resource": [options.data]};
            }

            // return response from server as promise
            return dfSystemData.resource(options).post(params, options.data, function (result) {

                // update the application object and session storage.
                if (result &&
                    result.resource &&
                    Object.prototype.toString.call(result.resource) === '[object Array]' &&
                    result.resource.length > 0) {

                    result = result.resource[0];
                }

                __insertApiData(api, result);
            });
        }

        // Save api data to server
        function _updateApiData(api, options) {

            // check for and remove null value params
            _checkParams(options);

            // set up our params
            var params = options.params;
            params['api'] = api;


            // had to put in this special rule
            // for config.  Do not send id param.
            if (api === 'config') {
                params.id = null;
            }

            // return response from server as promise
            return dfSystemData.resource({ url: options.url })[options.method || 'put'](params, options.data, function (result) {

                // update the application object and session storage.
                __updateApiData(api, result);
            });
        }

        // Delete api data from server
        // update session storage and app obj
        function _deleteApiData(api, options) {

            // check for and remove null value params
            _checkParams(options);

            // set up our params
            var params = options.params;
            params['api'] = api;
            params['rollback'] = _getAdminPrefs().settings.data[api].rollback;

            return dfSystemData.resource().delete(params, options.data, function (result) {

                // update the application object and session storage.
                __deleteApiData(api, result);
            })
        }

        // retrieves new data set from server
        // update session storage and app obj
        function _getDataSetFromServer(api, options) {

            options = options || {params: {}};

            var defaults = _getAdminPrefs().settings.data[api];

            options.params = dfObjectService.mergeObjects(defaults, options.params);

            // set up our params
            var params = options.params;
            params['api'] = api;

            // return response from server as promise
            return dfSystemData.resource(options).get(params, function (result) {

                // update the application object and session storage.
                __replaceApiData(api, result);
            });
        }

        // saves current user to server
        // update session storage and app obj
        function _saveAdminPrefs(adminPrefs) {

            var _prefs = {
                settings: adminPrefs,
                valid: true
            };

            dfApplicationPrefs.setPrefs(_prefs);

            var adminPreferences = {
                resource:[{
                    name:"adminPreferences",
                    value:adminPrefs
                }]
            };

            return UserDataService.saveUserSetting(adminPreferences);
        }

        // retrieves user setting
        function _getAdminPrefs() {

            var currentPrefs = dfApplicationPrefs.getPrefs();

            if (currentPrefs.settings === null) {

                var _adminPrefs = UserDataService.getUserSetting('adminPreferences', true);

                var _adminPrefsValue = angular.fromJson(_adminPrefs.response);

                if (_adminPrefs.status === 200) {
                    var _prefs = {
                        settings: _adminPrefsValue,
                        valid: true
                    };

                    if (_adminPrefsValue.hasOwnProperty('application') && _adminPrefsValue.application !== null) {
                        dfApplicationPrefs.setPrefs(_prefs);
                        return _prefs;
                    }
                }

                if (_adminPrefs.status === 404) {
                    dfApplicationPrefs.setPrefs()
                    return dfApplicationPrefs.getPrefs();
                }

                return currentPrefs;
            }
            else {
                return currentPrefs;
            }
        }

        // Insert data into local model dfApplicationObj
        function __insertApiData(api, dataObj) {

            // Check for existence of api and ensure that it is an array
            if (dfApplicationObj.apis.hasOwnProperty(api) && Object.prototype.toString.call(dfApplicationObj.apis[api].resource) === '[object Array]') {

                // Everything looks good...let's add the data object to the array
                dfApplicationObj.apis[api].resource.push(dataObj);
            }

            // Update record count
            if (dfApplicationObj.apis.hasOwnProperty(api) && dfApplicationObj.apis[api].hasOwnProperty('meta') && Object.prototype.toString.call(dfApplicationObj.apis[api].meta) === '[object Object]') {

                if (dfApplicationObj.apis[api].meta.hasOwnProperty('count')) {

                    dfApplicationObj.apis[api].meta['count']++;
                }
                else {

                    dfApplicationObj.apis[api].meta['count'] = 1;
                }
            }

            // Lets update our local storage.
            if (dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true))) {
                return true;
            }
        }

        // Insert data into local model dfApplicationObj
        function __updateApiData(api, dataObj) {

            if (dataObj.resource) {
                dataObj = dataObj.resource;
            }

            // Check for existence of api and ensure that it is an array
            if (dfApplicationObj.apis.hasOwnProperty(api) && Object.prototype.toString.call(dfApplicationObj.apis[api].resource) === '[object Array]') {

                // So counting vars
                var found = false,
                    i = 0;

                // looking for api record that was just updated
                while (!found && i <= dfApplicationObj.apis[api].resource.length - 1) {

                    // if we find it
                    if (dataObj.id === dfApplicationObj.apis[api].resource[i].id) {

                        // stop looping
                        found = true;

                        // remove it and splice in new one
                        dfApplicationObj.apis[api].resource.splice(i, 1, dataObj);
                    }

                    // duh
                    i++;
                }
            }

            // Lets update our local storage.
            if (dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true))) {
                return true;
            }
        }

        // Deletes data from local model dfApplicationObj
        function __deleteApiData(api, result) {

            // Searches for and removes a record from the local model
            function removeRecord(record) {

                // So counting vars
                var found = false,
                    i = 0;

                // looking for api record that was just deleted
                while (!found && i < dfApplicationObj.apis[api].resource.length) {

                    // if we find it
                    if (record.id === dfApplicationObj.apis[api].resource[i].id) {

                        // stop looping
                        found = true;

                        // remove it
                        dfApplicationObj.apis[api].resource.splice(i, 1);
                    }

                    // duh
                    i++;
                }
            }

            function updateCount() {

                // Update record count
                if (dfApplicationObj.apis.hasOwnProperty(api) && dfApplicationObj.apis[api].hasOwnProperty('meta') && Object.prototype.toString.call(dfApplicationObj.apis[api].meta) === '[object Object]') {

                    // Do we have a count property.  And we should
                    if (dfApplicationObj.apis[api].meta.hasOwnProperty('count')) {

                        // decrement
                        dfApplicationObj.apis[api].meta['count']--;
                    }
                }
            }


            // Sanity check for api.  Let's make sure it exists.
            if (dfApplicationObj.apis.hasOwnProperty(api) && Object.prototype.toString.call(dfApplicationObj.apis[api].resource) === '[object Array]') {

                // Deleting multiple records
                if (result.hasOwnProperty('resource')) {

                    // loop through them
                    angular.forEach(result.resource, function (_record) {

                        // remove from local model
                        removeRecord(_record);

                        // update count
                        updateCount();
                    })
                }
                else {

                    // Delete the single record from the local model
                    removeRecord(result);
                    updateCount();
                }

                // set to session storage
                if (dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true))) {
                    return true;
                }
            }
        }

        // Replaces a entire single api data set in
        // local model dfApplicationObj
        function __replaceApiData(api, result) {

            // Check for existence of api and ensure that it is an array
            if (dfApplicationObj.apis.hasOwnProperty(api) && Object.prototype.toString.call(dfApplicationObj.apis[api].resource) === '[object Array]') {

                // Everything looks good...let's add the data object to the array
                dfApplicationObj.apis[api].resource = result.resource;
            }

            // Lets update our local storage.
            if (dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true))) {
                return true;
            }
        }

        function _getLocation() {
            return $location.path();
        }

        function _systemDataExists(apiName) {

            var appObj = dfApplicationObj;

            if (appObj.hasOwnProperty('apis')) {
                if (appObj['apis'].hasOwnProperty(apiName)) {
                    return true;
                }
            }
            return false;
        }

        function _loadApi(apis) {

            var newApis = [];
            angular.forEach(apis, function(value) {
                if (_systemDataExists(value) === false) {
                    newApis.push(value);
                }
            });

            if (newApis.length > 0) {
                _asyncInit(newApis);
            }
        }


        return {

            initInProgress: false,
            initDeferred: null,

            // Public function to init the app
            init: function () {

                return _asyncInit([]);
            },

            // Returns app obj that is stored in the service
            getApplicationObj: function () {

                return dfApplicationObj;
            },

            // Sets app obj stored in the service
            // Useful for when the app obj is pulled from session storage
            // Otherwise the app obj should be built by init or other functions
            // strictly for editing the app obj
            setApplicationObj: function (appObj) {

                dfApplicationObj = appObj;
            },

            // for when you just have to update the applicationObj manually
            // certain things like updating schema components don't adhere
            // to the resource way of updating.  Having second thoughts about
            // the way that interface works.  Will revisit.
            setApplicationObjOverride: function (appObj) {

                dfApplicationObj = appObj;
                this.updateApplicationStore();
            },

            // Update browser sessionStorage with current dfApplicationObj in memory.
            updateApplicationStore: function () {

                dfSessionStorage.setItem('dfApplicationObj', angular.toJson(dfApplicationObj, true));
            },

            // removes the app obj from session storage and sets local copy to empty obj
            destroyApplicationObj: function () {

                // Set local app obj to empty
                _resetApplicationObj();

                // remove from session storage
                if (dfSessionStorage.removeItem('dfApplicationObj')) {
                    return true;
                }
            },

            // gets bootstrapped api data by name
            getApiData: function (api, options, forceRefresh) {

                options = options || null;

                if (forceRefresh) {

                    if(options && options.filter) {

                        var temp = _getAdminPrefs();
                        angular.extend(temp.settings['data'].admin, options);
                        _saveAdminPrefs(temp.settings)
                    } else {

                        var temp = _getAdminPrefs();
                        if(temp.settings['data'].admin && temp.settings['data'].admin.filter) delete temp.settings['data'].admin.filter;
                        _saveAdminPrefs(temp.settings)
                    }

                    return _fetchFromApi(api);
                }

                if (options === 'meta') {
                    if (dfApplicationObj.apis.hasOwnProperty(api) && dfApplicationObj.apis[api].meta) {
                        return dfApplicationObj.apis[api].meta
                    }
                    // dfNotify
                }
                else if (options === 'promise') {

                    var deferred = $q.defer();

                    if (dfApplicationObj.apis.hasOwnProperty(api)) {
                        if (dfApplicationObj.apis[api].resource) {
                            deferred.resolve(dfApplicationObj.apis[api].resource);
                        }
                        else {
                            deferred.resolve(dfApplicationObj.apis[api]);
                        }
                    }
                    return deferred.promise;
                }
                else {
                    // check for data
                    if (dfApplicationObj.apis.hasOwnProperty(api)) {

                        // Do we have any options
                        if (options) {
                            // we do make a temp var to hold results
                            var result = [];

                            // for each key in the options object
                            for (var key in options) {

                                // determine type
                                // we only accept strings and arrays
                                switch (Object.prototype.toString.call(options[key])) {

                                    // it's a comma delimited string
                                    case '[object String]':

                                        // make it an array
                                        options[key] = options[key].split(',');

                                        break;

                                    // it's an array do nothing
                                    case '[object Array]':

                                        break;

                                    // it's not a type we accept
                                    // throw an error
                                    default:

                                }

                                // Loop through each of the objects in the api we have asked for
                                angular.forEach(dfApplicationObj.apis[api].resource, function (obj) {

                                    // Loop through each value in option prop
                                    angular.forEach(options[key], function (value) {

                                        // does the obj have that prop and does the value equal the
                                        // current iterative value
                                        if (obj.hasOwnProperty(key) && obj[key] === value) {

                                            // yes.  add obj to result arr
                                            result.push(obj);
                                        }
                                    })
                                });
                            }

                            return result;
                        }
                        else {
                            // return if it exists
                            if (dfApplicationObj.apis[api].resource)
                                return dfApplicationObj.apis[api].resource;
                            else
                                return dfApplicationObj.apis[api];
                        }
                    }
                }
            },

            // save data to server and update app obj
            saveApiData: function (api, options) {

                if (dfApplicationObj.apis.hasOwnProperty(api)) {

                    return _saveApiData(api, options);
                }
            },

            // update data on server and update app obj
            updateApiData: function (api, options) {

                if (dfApplicationObj.apis.hasOwnProperty(api)) {

                    return _updateApiData(api, options);
                }
            },

            // delete data on server and update app obj
            deleteApiData: function (api, options) {

                if (dfApplicationObj.apis.hasOwnProperty(api)) {

                    return _deleteApiData(api, options);
                }
            },

            // retrieves more records from the db.  Will replace current
            // working set of records for specified api in the application obj
            getDataSetFromServer: function (api, options) {

                if (dfApplicationObj.apis.hasOwnProperty(api)) {

                    return _getDataSetFromServer(api, options);
                }
            },

            // retrieves the stored currentUser from local data model
            getCurrentUser: function () {

                if (dfApplicationObj.hasOwnProperty('currentUser')) {

                    return dfApplicationObj.currentUser;
                }
            },

            // saves current user preferences to server
            saveAdminPrefs: function (adminPrefs) {

                return _saveAdminPrefs(adminPrefs);
            },

            // get current user preferences from server
            getAdminPrefs: function () {

                return _getAdminPrefs();

            },

            // get data about current state of init
            getMainLoadData: function () {

                return dfMainLoadData;
            },

            getLocation: function () {
                return _getLocation();
            },

            getServiceComponents: function (serviceName, url, params, forceRefresh) {
                var deferred = $q.defer();
                var service = this.getApiData('service', { name: serviceName })[0];
                if (service.components && !forceRefresh) {
                    deferred.resolve(service.components);
                } else {
                    var apiUrl = url || INSTANCE_URL + '/api/v2/' + service.name + '/?as_access_list=true';
                    $http.get(apiUrl, params || {})
                        .success(function (result) {
                            service.components = result.resource || result;
                            deferred.resolve(service.components);
                            __updateApiData('service', service);
                        });
                }
                return deferred.promise;
            },

            updateServiceComponentsLocal: function (service) {
                var dfServiceData = this.getApiData('service', { name: service.name })[0];
                dfServiceData.components = service.components;
            },

            fetchFromApi: function(apiName) {
                return _fetchFromApi(apiName);
            },

            systemDataExists: function(apiName) {
                return _systemDataExists(apiName);
            },

            loadApi: function(apis) {
                return _loadApi(apis);
            },

            loadApiData: function(apis, forceRefresh) {
                return _loadApiData(apis, forceRefresh);
            }

        }
    }])

    .service('dfSystemData', ['$http', 'XHRHelper', 'INSTANCE_URL', '$resource', 'dfObjectService', function ($http, XHRHelper, INSTANCE_URL, $resource, dfObjectService) {


        // Private synchronous function to retrieve services when app is bootstrapped
        function _getServiceDataFromServerSync(requestDataObj) {

            var xhr = XHRHelper.ajax(requestDataObj);


            var xhr = $.ajax(requestDataObj);

            // Check response
            if (xhr.readyState == 4 && xhr.status == 200) {

                // Good response.
                return angular.fromJson(xhr.responseText);

            } else if (xhr.readyState == 4 && (xhr.status === 401)) {

                return 'Unauthorized';
            } else {

            }

        }

        return {

            // Public synchronous function to retrieve our system services
            // and store them in our service
            getSystemApisFromServerSync: function (api) {

                var requestDataObj = {
                    url: 'system/' + api.api_name,
                    params: api.params
                };

                return _getServiceDataFromServerSync(requestDataObj);
            },

            getSystemApisFromServer: function (api) {

                return $http({
                    url: INSTANCE_URL + '/api/v2/system/' + api.api_name,
                    method: 'GET',
                    params: api.params
                });

            },

            http: function (api, options) {

                return {

                    delete: function () {
                        return $http({
                            url: INSTANCE_URL + '/api/v2/system/' + api,
                            method: 'DELETE',
                            data: options.data
                        })
                    }
                }
            },

            resource: function (options) {

                options = options || {};

                var defaults = {
                    headers: ''
                };

                options = dfObjectService.mergeObjects(options, defaults);
                var url = options.url || INSTANCE_URL + '/api/v2/system/:api/:id';
                var queryParams = options.queryParams || { api: '@api', id: '@id' };


                // Return a resource for our service so we can just call the operation we want.
                return $resource(url, queryParams, {

                    get: {
                        method: 'GET',
                        headers: options.headers
                    },
                    post: {
                        method: 'POST',
                        headers: options.headers
                    },
                    put: {
                        method: 'PUT',
                        headers: options.headers
                    },
                    patch: {
                        method: 'PATCH',
                        headers: options.headers
                    },
                    delete: {
                        method: 'DELETE',
                        headers: options.headers
                    }
                });
            }
        }
    }])

    .factory('dfApplicationPrefs', [function () {

        var prefs = {
            settings: null,
            valid: false
        };

        var prefsDefault = {
            settings: {
                application: {
                    notificationSystem: {
                        success: 'pnotify',
                        error: 'pnotify',
                        warn: 'pnotify'
                    }
                },
                data: {
                    app: {
                        include_count: true,
                        limit: 100,
                        related: 'role_by_role_id'
                    },
                    app_group: {
                        include_count: true,
                        limit: 100,
                        related: 'app_to_app_group_by_group_id'
                    },
                    role: {
                        include_count: true,
                        related: 'role_service_access_by_role_id,role_lookup_by_role_id',
                        limit: 100
                    },
                    admin: {
                        include_count: true,
                        limit: 20,
                        related: 'user_lookup_by_user_id'
                    },
                    user: {
                        include_count: true,
                        limit: 20,
                        related: 'user_lookup_by_user_id,user_to_app_to_role_by_user_id'
                    },
                    service: {
                        include_count: true,
                        include_components: true,
                        limit: 100
                    },
                    config: {},
                    email_template: {
                        include_count: true
                    },
                    lookup: {
                        include_count: true
                    },
                    cors: {
                        include_count: true
                    },
                    event: {
                        scriptable: true
                    },
                    limit: {
                        include_count: true,
                        limit: 20,
                        related: 'service_by_service_id,role_by_role_id,user_by_user_id'
                    },
                    limit_cache: {
                        include_count: true,
                        limit: 20
                    }
                },

                sections: {
                    app: {
                        autoClose: false,
                        manageViewMode: 'table'
                    },
                    role: {
                        autoClose: false,
                        manageViewMode: 'table'
                    },
                    admin: {
                        autoClose: false,
                        manageViewMode: 'table'
                    },
                    user: {
                        autoClose: false,
                        manageViewMode: 'table'
                    },
                    service: {
                        autoClose: false,
                        manageViewMode: 'table'
                    }
                }
            },
            valid: true
        };

        return {


            getPrefs: function () {

                return prefs;
            },

            setPrefs: function (data) {

                prefs = (data) ? data : prefsDefault;
            }

        }
    }])

    // This intercepts outgoing http calls.  Checks for restricted verbs from config
    // and tunnels them through a POST if necessary
    .factory('httpVerbInterceptor', ['$q', 'SystemConfigDataService', function ($q, SystemConfigDataService) {

        return {

            request: function (config) {

                if (SystemConfigDataService.getSystemConfig().restricted_verbs.length <= 0) return config;

                var restricted_verbs = SystemConfigDataService.getSystemConfig().restricted_verbs,
                    i = 0,
                    currMethod = config.method;

                while (i < restricted_verbs.length) {

                    if (currMethod === restricted_verbs[i]) {
                        config.method = "POST";
                        config.headers['X-HTTP-METHOD'] = currMethod;
                        break;
                    }

                    i++
                }

                return config;
            }
        }
    }])


    .factory('httpWrapperInterceptor', [ 'SystemConfigDataService',
        function (SystemConfigDataService) {
            return {
                request: function (config) {

                    var environment = SystemConfigDataService.getSystemConfig() || {};

                    if (!environment.config) {
                        return config;
                    }

                    if (config.data instanceof Array && environment.config.alway_wrap_resources) {
                        // wrap the data with always_wrap_resources
                        var data = {};
                        data[environment.config.resource_wrapper] = angular.copy(config.data);
                        config.data = data;
                    }

                    return config;
                },

                response: function (response) {

                    var environment = SystemConfigDataService.getSystemConfig() || {};

                    if (typeof(response.data) !== 'object' || !environment.config) {
                        return response;
                    }


                    var keys = Object.keys(response.data);

                    if (environment.config.always_wrap_resources && keys.length === 1 && response.data[keys[0]] instanceof Array && keys[0] === environment.config.resource_wrapper) {
                        response.data = response.data[environment.config.resource_wrapper];
                    }

                    return response;
                }
            }
        }
    ])

    // Intercepts outgoing http calls.  Checks for valid session.  If 401 will trigger a pop up login screen.
    .factory('httpValidSession', ['$q', '$rootScope', '$location', 'INSTANCE_URL', '$injector', '$cookies', function ($q, $rootScope, $location, INSTANCE_URL, $injector, $cookies) {


        var putSession = function (reject) {
            var $http = $injector.get('$http');
            var UserDataService = $injector.get('UserDataService');
            var user = UserDataService.getCurrentUser();
            var deferred = $injector.get('$q').defer();

            var url = user.is_sys_admin ? '/api/v2/system/admin/session' : '/api/v2/user/session';

            $http({
                method: 'PUT',
                url: INSTANCE_URL + url
            }).then(function (result) {
                $http.defaults.headers.common['X-DreamFactory-Session-Token'] = result.data.session_token;
                $cookies.PHPSESSID = $cookies.PHPSESSID === result.data.session_token ? $cookies.PHPSESSID : result.data.session_token
                UserDataService.setCurrentUser(result.data);
                retry(reject.config, deferred);
            }, function () {
                refreshSession(reject, deferred)
            });

            return deferred.promise;
        };

        var retry = function (config, deferred) {

            var request = {
                method: config.method,
                url: config.url
            };
            if (config.data) {
                request.data = config.data;
            }
            if (config.transformRequest) {
                request.transformRequest = config.transformRequest;
            }
            var $http = $injector.get('$http');
            $http(request).then(deferred.resolve, deferred.reject);
            return deferred.promise;
        };

        var refreshSession = function (reject, deferred) {
            //Clear cookies.
            $cookies.PHPSESSID = '';

            //Clear current header.
            var $http = $injector.get('$http');
            $http.defaults.headers.common['X-DreamFactory-Session-Token'] = '';

            //Clear current user.
            var UserDataService = $injector.get('UserDataService');
            UserDataService.unsetCurrentUser();

            var UserEventsService = $injector.get('UserEventsService');
            var deferred = deferred || $injector.get('$q').defer();

            $rootScope.$$childHead.openLoginWindow(reject);
            $rootScope.$on('user:login:success', function () {
                retry(reject.config, deferred);
            });

            return deferred.promise
        };

        return {

            request: function (config) {

                return config;
            },

            requestError: function (reject) {

                return $q.reject(reject);
            },

            response: function (response) {

                return response;
            },

            responseError: function (reject) {


                // If we get an error from any of the
                // login / register pages, ignore it.
                // No need to pop up a login.
                switch ($location.path()) {

                    case '/login':
                    case '/user-invite':
                    case '/admin-invite':
                    case '/register-confirm':
                    case '/register':
                    case '/register-complete':
                        break;

                    default:
                        if (reject.status !== 401) break;
                        if (reject.config.ignore401) break;

                        if ((reject.status === 401 || reject.data.error.code === 401)  && reject.config.url.indexOf('/session') === -1 && $rootScope.initInProgress === false) {
                            if (reject.data.error.message === 'Token has expired' || reject.config.url.indexOf('/profile') !== -1) {
                                //  put session
                                return putSession(reject);
                            }
                            else {
                                // refresh session
                                return refreshSession(reject);
                            }
                        }
                }


                return $q.reject(reject);
            }
        }
    }])

    // paginates tables
    .directive('dfPaginateTable', ['MOD_UTILITY_ASSET_PATH', 'INSTANCE_URL', '$http', 'dfApplicationData', 'dfApplicationPrefs', 'dfNotify',
        function (MOD_UTILITY_ASSET_PATH, INSTANCE_URL, $http, dfApplicationData, dfApplicationPrefs, dfNotify) {

            return {

                restrict: 'E',
                scope: {
                    api: '=',
                    linkedData: '=',
                    prepFunc: '&'
                },
                templateUrl: MOD_UTILITY_ASSET_PATH + 'views/df-paginate-table.html',
                link: function (scope, elem, attrs) {


                    scope.totalCount = dfApplicationData.getApiData(scope.api, 'meta').count;
                    scope.pagesArr = [];
                    scope.currentPage = {};
                    scope.isInProgress = false;


                    // PUBLIC API
                    scope.getPrevious = function () {

                        if (scope._isFirstPage() || scope.isInProgress) {
                            return false;
                        } else {

                            scope._getPrevious();

                        }
                    };

                    scope.getNext = function () {

                        if (scope._isLastPage() || scope.isInProgress) {
                            return false;
                        } else {

                            scope._getNext();

                        }
                    };

                    scope.getPage = function (pageObj) {

                        scope._getPage(pageObj);
                    };


                    // PRIVATE API


                    // Data
                    scope._getDataFromServer = function (offset) {

                        return dfApplicationData.getDataSetFromServer(scope.api, {
                            params: {
                                offset: offset
                            }
                        }).$promise
                    };

                    // Pagination
                    scope._calcTotalPages = function (totalCount, numPerPage) {

                        return Math.ceil(totalCount / numPerPage);
                    };

                    scope._createPageObj = function (_pageNum) {

                        return {
                            number: _pageNum + 1,
                            value: _pageNum,
                            offset: _pageNum * _getAdminPrefs().settings.data[scope.api].limit,
                            stopPropagation: false
                        }
                    };

                    scope._createPagesArr = function (_totalCount) {


                        scope.pagesArr = [];

                        for (var i = 0; i < _totalCount; i++) {

                            scope.pagesArr.push(scope._createPageObj(i));
                        }
                    };

                    scope._setCurrentPage = function (pageDataObj) {

                        scope.currentPage = pageDataObj;
                    };

                    scope._getCurrentPage = function () {

                        if (!scope.currentPage && scope.pagesArr.length > 0) {
                            scope.currentPage = scope.pagesArr[0];
                        } else if (!scope.currentPage && !scope.pagesArr.length) {

                            scope.pagesArr.push(scope._createPageObj(0));
                            scope.currentPage = scope.pagesArr[0];
                        }

                        return scope.currentPage;
                    };

                    scope._isFirstPage = function () {

                        return scope._getCurrentPage().value === 0;
                    };

                    scope._isLastPage = function () {

                        return scope.currentPage.value === scope.pagesArr.length - 1
                    };

                    scope._previousPage = function () {

                        scope.currentPage = scope.pagesArr[scope.currentPage.value - 1]
                    };

                    scope._nextPage = function () {

                        scope.currentPage = scope.pagesArr[scope.currentPage.value + 1]
                    };

                    scope._calcPagination = function (newValue) {

                        scope.pagesArr = [];

                        if (scope.totalCount == 0) {
                            scope.pagesArr.push(scope._createPageObj(0));
                            return false;
                        }

                        scope._createPagesArr(scope._calcTotalPages(scope.totalCount, _getAdminPrefs().settings.data[newValue].limit));
                    };


                    // COMPLEX IMPLEMENTATION
                    scope._getPrevious = function () {

                        if (scope.isInProgress) return false;

                        scope.isInProgress = true;

                        var offset = scope.pagesArr[scope.currentPage.value - 1].offset

                        scope._getDataFromServer(offset).then(
                            function (result) {

                                scope.linkedData = scope.prepFunc({dataArr: result.resource});
                                scope._previousPage();
                            },

                            function (reject) {

                                var messageOptions = {
                                    module: 'DreamFactory Paginate Table',
                                    type: 'error',
                                    provider: 'dreamfactory',
                                    message: reject
                                };

                                dfNotify.error(messageOptions);
                            }
                        ).finally(
                            function () {

                                scope.isInProgress = false;
                            }
                        )
                    };

                    scope._getNext = function () {

                        if (scope.isInProgress) return false;

                        scope.isInProgress = true;

                        var offset = scope.pagesArr[scope.currentPage.value + 1].offset

                        scope._getDataFromServer(offset).then(
                            function (result) {
                                scope.linkedData = scope.prepFunc({dataArr: result.resource});
                                scope._nextPage();
                            },

                            function (reject) {

                                var messageOptions = {
                                    module: 'DreamFactory Paginate Table',
                                    type: 'error',
                                    provider: 'dreamfactory',
                                    message: reject
                                };

                                dfNotify.error(messageOptions);
                            }
                        ).finally(
                            function () {

                                scope.isInProgress = false;
                            }
                        )
                    };

                    scope._getPage = function (pageObj) {

                        if (scope.isInProgress) return false;

                        scope.isInProgress = true;

                        scope._getDataFromServer(pageObj.offset).then(
                            function (result) {

                                scope.linkedData = scope.prepFunc({dataArr: result.resource});
                                scope._setCurrentPage(pageObj);
                            },

                            function (reject) {

                                var messageOptions = {
                                    module: 'DreamFactory Paginate Table',
                                    type: 'error',
                                    provider: 'dreamfactory',
                                    message: reject
                                };

                                dfNotify.error(messageOptions);
                            }
                        ).finally(
                            function () {

                                scope.isInProgress = false;
                            }
                        )

                    };


                    // WATCHERS
                    var watchApi = scope.$watch('api', function (newValue, oldValue) {

                        if (!newValue) return false;
                        scope._calcPagination(newValue);
                        scope._setCurrentPage(scope.pagesArr[0]);
                    });


                    // MESSAGES
                    scope.$on('dfPaginate:reset:' + scope.api, function (e) {

                        if (scope.isInProgress) return false;

                        scope.isInProgress = true;

                        var offset = 0;

                        scope._getDataFromServer(offset).then(
                            function (result) {
                                scope.linkedData = scope.prepFunc({dataArr: result.resource});
                                scope._setCurrentPage(scope.pagesArr[0]);
                            },

                            function (reject) {

                                var messageOptions = {
                                    module: 'DreamFactory Paginate Table',
                                    type: 'error',
                                    provider: 'dreamfactory',
                                    message: reject
                                };

                                dfNotify.error(messageOptions);
                            }
                        ).finally(
                            function () {

                                scope.isInProgress = false;
                            }
                        )
                    })
                }
            }
        }]);