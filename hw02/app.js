const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const etag = require('etag');

const hostname = '0.0.0.0';
const httpPort = 3000;
const httpsPort = 3001;
const resourceBaseDir = path.join(__dirname, 'public');

const httpsOptions = {
    key: fs.readFileSync('certs/localhost.key'),
    cert: fs.readFileSync('certs/localhost.crt'),
};

const getResourcePath = (filePath) => path.join(resourceBaseDir, filePath);
const isUnderDirectory = (dir, filePath) => path.normalize(filePath).startsWith(path.normalize(dir));
const getSafeResourcePath = (filePath) => {
    const resourcePath = getResourcePath(filePath);
    return isUnderDirectory(resourceBaseDir, resourcePath) ? resourcePath : resourceBaseDir;
};

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

const fileRequestHandler = (request, response) => {
    const resourcePath = getSafeResourcePath(request.url);
    fs.readFile(resourcePath, (err, data) => {
        if (err) {
            switch (err.code) {
                case 'EACCES':
                    response.statusCode = 403;
                    break;
                case 'ENOENT':
                    response.statusCode = 404;
                    break;
                default:
                    response.statusCode = 404;
                    break;
            }
            response.end();
            return;
        }

        const etagHeader = etag(data);
        const clientIfNoneMatch = request.headers['if-none-match'];

        if (clientIfNoneMatch == etagHeader) {
            response.statusCode = 304;
            response.end();
            return;
        }

        const mimeType = mime.lookup(resourcePath);

        response.statusCode = 200;
        response.setHeader('Content-Type', mimeType);
        response.setHeader('ETag', etagHeader);
        response.end(data);
    });
};

const requestHandler = (request, response) => {
    const requestUrl = request.url;

    if (requestUrl in routes) {
        routes[requestUrl](request, response);
        return;
    }

    fileRequestHandler(request, response);
};

const httpRequestHandler = (request, response) => {
    if (request.headers['upgrade-insecure-requests'] === '1') {
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

const logRequest = (request, response) => {
    const timeString = (new Date()).toISOString();
    const remoteAddress = request.socket.remoteAddress;
    const remotePort = request.socket.remotePort;
    const statusCode = response.statusCode;
    const requestUrl = request.url;
    console.log(`[${timeString}] ${remoteAddress}:${remotePort} [${statusCode}]: ${requestUrl}`);
};

const httpServer = http.createServer(httpRequestHandler);
const httpsServer = https.createServer(httpsOptions, requestHandler);

httpServer.on('request', logRequest);
httpsServer.on('request', logRequest);

httpServer.listen(httpPort, hostname, () => {
    console.log(`Resource Directory: ${resourceBaseDir}`);
    console.log(`Server running at http://${hostname}:${httpPort}/`);
});

httpsServer.listen(httpsPort, hostname, () => {
    console.log(`Resource Directory: ${resourceBaseDir}`);
    console.log(`Server running at https://${hostname}:${httpsPort}/`);
});
