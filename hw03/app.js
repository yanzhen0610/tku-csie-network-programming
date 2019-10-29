const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const formidable = require('formidable');

const hostname = '0.0.0.0';
const httpPort = 8080;
const httpsPort = 8081;
const resourceBaseDir = path.join(__dirname, 'public');
const storageBaseDir = path.join(__dirname, 'storage');
const maxFields = 1024;
const maxFieldsSize = 20 * 1024 * 1024;
const maxFileSize = 200 * 1024 * 1024;

const httpsOptions = {
    key: fs.readFileSync(path.normalize('certs/localhost.key')),
    cert: fs.readFileSync(path.normalize('certs/localhost.crt')),
};

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

    form.parse(request, (error, fields, files) => {
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
            const filePath = getStoragePath(file.name);
            fs.unlink(filePath, (error) => {
                fs.rename(file.path, filePath, (error) => {
                    if (error) {
                        console.log(error);
                    }
                });
            });
        };

        response.end();
    });
};

const fileRequestHandler = (request, response) => {
    const handlePublicFilePromise = new Promise((resolve, reject) => {
        const resourcePath = getResourcePath(decodeURI(request.url));
        fs.readFile(resourcePath, (error, data) => {
            if (error) {
                reject(error);
            }
            resolve(data);
        });
    });

    handlePublicFilePromise.then((data) => {
        response.statusCode = 200;
        response.end(data);
    }).catch((error) => {
        const handleStorageFilePromise = new Promise((resolve, reject) => {
            const storagePath = getStoragePath(decodeURI(request.url));
            fs.readFile(storagePath, (error, data) => {
                if (error) {
                    reject(error);
                }
                resolve(data);
            })
        });

        handleStorageFilePromise.then((data) => {
            response.statusCode = 200;
            response.end(data);
        }).catch((error) => {
            response.statusCode = 404;
            switch (error.code) {
                case 'EACCES':
                    response.statusCode = 403;
                    break;
                case 'ENOENT':
                default:
            }
            response.end();
        });
    });
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
    response.on('close', () => {
        logRequest(request, response, Date.now() - start);
    });

    const requestUrl = request.url;

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
