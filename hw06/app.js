const url = require('url');
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsAsync = fs.promises; // it's experimental :D, but I'd like to use it in order to make the code more readable
const path = require('path');
const formidable = require('formidable');
const httpRequest = require('request');

const hostname = '0.0.0.0';
const httpPort = 8080;
const httpsPort = 8081;
const resourceBaseDir = path.resolve('public');
const storageBaseDir = path.resolve('storage');
const maxFields = 1024;
const maxFieldsSize = 20 * 1024 * 1024;
const maxFileSize = 200 * 1024 * 1024;

const ipGeolocationApiKey = process.env.IP_GEOLOCATION_API_KEY;

const httpsOptions = {
    key: fs.readFileSync(path.normalize('certs/localhost.key')),
    cert: fs.readFileSync(path.normalize('certs/localhost.crt')),
};

// path.join('/', '../../..') => '/'
const getResourcePath = (filePath) => path.join(resourceBaseDir, path.join('/', filePath));
const getStoragePath = (filePath) => path.join(storageBaseDir, path.join('/', filePath));

const routes = {};

routes['/sse'] = (request, response) => {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });
    response.write('\n');

    let messageId = 0;

    const intervalId = setInterval(() => {
        response.write(`id: ${messageId++}\n`);
        response.write(`data: ${(new Date()).toISOString()}\n\n`);
    }, 100);

    request.on('close', () => {
        clearInterval(intervalId);
    });
};

routes['/upload'] = (request, response) => {
    const form = new formidable.IncomingForm();
    form.uploadDir = storageBaseDir;
    form.maxFields = maxFields;
    form.maxFieldsSize = maxFieldsSize;
    form.maxFileSize = maxFileSize;

    form.parse(request, async (error, fields, files) => {
        if (error) {
            console.log(error);
            response.end(error);
            return;
        }

        response.write(JSON.stringify({
            fields,
            files,
        }));

        if (files) for (let file of Object.values(files)) {
            const filePathToSave = getStoragePath(file.name);
            try { await fsAsync.unlink(filePathToSave); } catch (e) { }
            try {
                await fsAsync.rename(file.path, filePathToSave);
            } catch (error) {
                console.log(error);
            }
        };

        response.end();
    });
};

routes['/ip_geolocation'] = async (request, response) => {
    const request_ip = url.parse(request.url, true).query.ip;

    if (!request_ip) {
        response.statusCode = 400;
        response.end();
        return;
    }

    httpRequest(`https://api.ipgeolocation.io/ipgeo?apiKey=${ipGeolocationApiKey}&ip=${request_ip}`, (error, api_response, body) => {
        if (error || !api_response || api_response.statusCode !== 200) {
            response.statusCode = 500;
            response.end();
            return;
        }

        const data = JSON.parse(body);

        response.statusCode = 200;
        response.end(JSON.stringify({
            country: data.country_name,
            city: data.city,
            ip: data.ip,
            isp: data.isp,
            lat: data.latitude,
            lng: data.longitude,
        }));
    });

};

const fileRequestHandler = async (request, response) => {
    const requestUrl = decodeURI(request.url);

    try {
        const data = await fsAsync.readFile(getResourcePath(requestUrl));;
        response.statusCode = 200;
        response.end(data);
    } catch (e) {
        try {
            const data = await fsAsync.readFile(getStoragePath(requestUrl));
            response.statusCode = 200;
            response.end(data);
        } catch (e) {
            response.statusCode = 404;
            response.end();
        }
    }
};

const logRequest = (request, response, duration) => {
    const timeString = (new Date()).toISOString();
    const statusCode = response.statusCode;
    const remoteAddress = request.socket.remoteAddress;
    const remotePort = request.socket.remotePort;
    const requestUrl = request.url;
    const userAgent = request.headers['user-agent'];
    const durationMs = duration / 1000;
    console.log(`[${timeString}] ${remoteAddress}:${remotePort} [${statusCode}] ${durationMs}ms: ${requestUrl} ${userAgent}`);
};

const requestHandler = (request, response) => {
    const start = Date.now();
    response.on('close', () => logRequest(request, response, Date.now() - start));

    const requestUrl = url.parse(request.url, true).pathname;

    if (requestUrl in routes) {
        routes[requestUrl](request, response);
        return;
    }

    fileRequestHandler(request, response);
};

const httpRequestHandler = (request, response) => {
    if (request.headers['upgrade-insecure-requests'] === '1') {
        /**
         * If the client request has a header named `upgrade-insecure-requests`
         * then uses status code `302`(temporary redirect) to redirect the
         * client to https.
         */

        let requestHost = request.headers['host'];
        const indexOfColon = requestHost.indexOf(':');
        if (indexOfColon !== -1) {
            requestHost = requestHost.slice(0, indexOfColon);
        }
        const url = `https://${requestHost}:${httpsPort}${request.url}`;
        response.setHeader('Location', url);
        response.setHeader('Vary', 'Upgrade-Insecure-Requests');
        response.statusCode = 302;
        response.end();
        return;
    }

    requestHandler(request, response);
};

const httpServer = http.createServer(httpRequestHandler);
const httpsServer = https.createServer(httpsOptions, requestHandler);

try {
    fs.mkdirSync(storageBaseDir);
} catch (error) {
    if (error.code !== 'EEXIST') {
        throw error;
    }
}
try {
    fs.mkdirSync(resourceBaseDir);
} catch (error) {
    if (error.code !== 'EEXIST') {
        throw error;
    }
}

httpServer.listen(httpPort, hostname, () => {
    console.log(`Resource Directory: ${resourceBaseDir}`);
    console.log(`Server running at http://${hostname}:${httpPort}/`);
});

httpsServer.listen(httpsPort, hostname, () => {
    console.log(`Resource Directory: ${resourceBaseDir}`);
    console.log(`Server running at https://${hostname}:${httpsPort}/`);
});
