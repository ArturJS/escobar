const http = require('http');
const querystring = require('querystring');
const urlParser = require('url');
const HttpHelper = require('./http_helper');
const MultipartFormDataParser = require('./multipart_form_data_parser');


function errorResponse(requestData, code) {
    const statusText = http.STATUS_CODES[code] || 'Internal server error';
    requestData._response.statusCode = code;
    requestData._response.statusMessage = statusText;

    requestData._clientResponse = statusText;
}

module.exports = function () {
    return http.createServer(async (request, response) => {
        let requestData = {
            _request: request,
            _response: response,
            _route: false, // Endpoint route (example: /api/version)

            /**
             * _routeParams explanation.
             * Example:
             * If _route = /api/user, but request.url = /api/user/1337/remove,
             * in this case _routeParams = [1337, 'remove'].
             * If request.url == /api/user, _routeParams will be empty array [].
             */
            _routeParams: [],
            _clientResponse: '', // This will be send to client response
            _execOnBeforeSendResponse: true, // Exec onBeforeSendResponse hook?
            _execRouting: true, // Exec routing?
            _execRoute: true, // Exec route?
            _customResponse: false, // If true, response.end(requestData._clientResponse); will not be executed in the end of request life cycle
            _http: HttpHelper(response, request), // help functions
            $_DATA: {}, // Data from body
            $_GET: {}, // Data from url query
            $_FILES: {}, // Uploaded files
        };

        try {
            await this.emit('request', requestData);

            request.on('error', (err) => {
                console.error(err);
                errorResponse(requestData, 500);
            });

            response.on('error', (err) => {
                console.error(err);
            });

            if (requestData._execRouting) {
                // If we define requestData._route manually, we will try to navigate using this url, not url from request
                let url = requestData._route;
                if (!url) {
                    // Parse URl and filter it from query string (GET params)
                    const parsedURL = urlParser.parse(request.url, true);
                    url = parsedURL.pathname;
                    if (url.length > 1 && url.substr(-1) == '/') {
                        url = url.substr(0, url.length - 1);
                    }
                }

                // Try to find route
                let renderFunc = this.routes[url];
                if (!renderFunc) {
                    let routePath;
                    let splitted = url.split('/');
                    splitted.shift();
                    while (splitted.length) {
                        routePath = '/' + splitted.join('/');
                        renderFunc = this.routes[routePath];
                        if (renderFunc) {
                            requestData._route = routePath;
                            requestData._routeParams = url.substr(routePath.length + 1).split('/');
                            break;
                        }
                        splitted.pop();
                    }
                } else {
                    requestData._route = url;
                }


                if (renderFunc) {
                    let body = [];

                    // Headers check
                    const contentType = request.headers[ 'content-type' ];
                    const isMultipart = contentType && contentType.indexOf('multipart/form-data') == 0;
                    const isJson = contentType && contentType.indexOf('application/json') == 0;
                    const isFormUrlencoded = contentType && contentType.indexOf('application/x-www-form-urlencoded') == 0;

                    let multipartFormDataParser = null;
                    if (this.useMultipartParser) {
                        if (isMultipart) {
                            multipartFormDataParser = new MultipartFormDataParser(contentType, requestData);
                        }
                    }

                    let queryStrIndex = request.url.indexOf('?');
                    if (queryStrIndex >= 0) {
                        requestData.$_GET = querystring.parse(request.url.substr(queryStrIndex + 1)) || {};
                        requestData.$_GET = JSON.parse(JSON.stringify(requestData.$_GET));
                    }


                    // Wait for request end and after that we will be ready to send response
                    await (() => new Promise((resolve) => {
                        let chunks = 0;
                        let isEnd = false;

                        request.on('data', async (chunk) => {
                            chunks++;
                            try {
                                if ((this.useJsonParser && isJson) || (this.useUrlencodedParser && isFormUrlencoded)) body.push(chunk);
                                if (this.useMultipartParser && isMultipart) await multipartFormDataParser.addChunk(chunk);
                            }
                            catch (e) {
                                console.error(e);
                            }
                            chunks--;
                            if (chunks == 0 && isEnd) resolve(true);
                        });

                        request.on('end', () => {
                            isEnd = true;
                            if (chunks == 0) resolve(true);
                        });
                    }))();

                    response.on('error', (err) => {
                        console.error(err);
                    });

                    if (((this.useJsonParser && isJson) || (this.useUrlencodedParser && isFormUrlencoded)) && body.length) {
                        if (isJson) requestData.$_DATA = JSON.parse(Buffer.concat(body).toString());
                        if (isFormUrlencoded) requestData.$_DATA = querystring.parse(Buffer.concat(body).toString());
                        requestData.$_DATA = JSON.parse(JSON.stringify(requestData.$_DATA));
                    }

                    await this.emit('before_endpoint', requestData);

                    if (requestData._execRoute) {
                        if (this.hasSubscribe('exec_route')) {
                            await this.emit('exec_route', requestData, renderFunc);
                        } else {
                            requestData._clientResponse = await renderFunc(requestData);
                        }
                    }
                } else {
                    if (this.hasSubscribe('not_found')) {
                        await this.emit('not_found', requestData);
                    } else {
                        errorResponse(requestData, 404);
                    }
                }
            }
        } catch (e) {
            try {
                console.error(e);
                if (this.hasSubscribe('error')) {
                    await this.emit('error', requestData, e);
                } else {
                    errorResponse(requestData, 500);
                }
            } catch (e) {
                console.error(e);
                errorResponse(requestData, 500);
            }
        }


        try {
            if (requestData._execOnBeforeSendResponse) await this.emit('before_send_response', requestData);

            if (!requestData._customResponse) {
                response.end(requestData._clientResponse);
            }
        } catch (e) {
            console.error(e);
        }
    });
};