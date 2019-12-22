const url = require('url');
const http = require('http');
const https = require('https');
const cookie = require('cookie');
const fs = require('fs');
const fsAsync = fs.promises; // it's experimental :D, but I'd like to use it in order to make the code more readable
const path = require('path');
const formidable = require('formidable');
const httpRequest = require('request');
const bcrypt = require('bcrypt');
const { Sequelize, Model, DataTypes } = require('sequelize');
const socketIo = require('socket.io');

const hostname = '0.0.0.0';
const httpPort = 8080;
const httpsPort = 8081;
const resourceBaseDir = path.resolve('public');
const storageBaseDir = path.resolve('storage');
const maxFields = 1024;
const maxFieldsSize = 20 * 1024 * 1024;
const maxFileSize = 200 * 1024 * 1024;
const dbPath = 'database';
const sequelize = new Sequelize({ dialect: 'sqlite', storage: dbPath, logging: false });
const sessionIdCookieName = 'session-id';
const sessionIdLength = 128;
const sessionLifetime = 60 * 60 * 2; // 2 hours
const passwordSaltRounds = 10;

const ipGeolocationApiKey = process.env.IP_GEOLOCATION_API_KEY;

const httpsOptions = {
    key: fs.readFileSync(path.normalize('certs/localhost.key')),
    cert: fs.readFileSync(path.normalize('certs/localhost.crt')),
};

const form = new formidable.IncomingForm();
form.uploadDir = storageBaseDir;
form.maxFields = maxFields;
form.maxFieldsSize = maxFieldsSize;
form.maxFileSize = maxFileSize;

try {
    fs.mkdirSync(storageBaseDir);
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}
try {
    fs.mkdirSync(resourceBaseDir);
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
}

// models
class User extends Model { };
User.init({
    username: DataTypes.STRING,
    password: DataTypes.STRING,
}, { sequelize, modelName: 'user' });

// routes
class Routes {
    constructor() {
        this.routes = {}
    }
    add(method, path, callback) {
        if (this.routes[method] === undefined) {
            this.routes[method] = [];
        }
        this.routes[method].push({
            path,
            callback,
        });
    }
    getHandler(method, path) {
        const routes = this.routes[method];
        if (!routes) return;
        for (let route of routes) {
            if (isString(route.path)) {
                if (route.path == path) {
                    return route.callback;
                }
            } else if (route.path.test(path)) {
                return route.callback;
            }
        }
    }
};
const routes = new Routes();

const createTables = async () => {
    sequelize.getQueryInterface().createTable('users', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        username: {
            type: DataTypes.STRING,
            unique: true,
        },
        password: { type: DataTypes.STRING },
        createdAt: { type: DataTypes.DATE },
        updatedAt: { type: DataTypes.DATE },
    });
};

const socketIoEventHandlers = {};
const socketIoHandler = socket => {
    if (!isString(socket.handshake.headers.cookie)) return socket.disconnect(true);

    const cookies = cookie.parse(socket.handshake.headers.cookie);
    const sessionId = cookies[sessionIdCookieName];
    if (!sessionId) return socket.disconnect(true);

    const session = sessions[sessionId];
    if (session === undefined) return socket.disconnect(true);

    socket.session = session;

    for (let event of Object.keys(socketIoEventHandlers)) {
        socket.on(event, socketIoEventHandlers[event](socket));
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

const sessions = {};
const startSession = (request, response) => {
    // if client has a valid session ID then skip
    if (isString(request.headers.cookie)) {
        const cookies = cookie.parse(request.headers.cookie);
        const sessionId = cookies[sessionIdCookieName];
        if (sessionId) {
            const session = sessions[sessionId];
            if (session !== undefined) {
                request.session = session;
                return;
            }
        }
    }

    // start a new session
    const sessionId = randomString(sessionIdLength);
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + sessionLifetime);
    const session = {
        data: {},
        expiresAt,
    };
    sessions[sessionId] = session;
    request.session = session;
    setTimeout(() => delete sessions[sessionId], sessionLifetime * 1000); // flush session after timeout
    response.setHeader('Set-Cookie', cookie.serialize(sessionIdCookieName, sessionId, {
        httpOnly: true,
        maxAge: sessionLifetime,
    }));
};

const isAuthenticated = (request) => {
    return !!request.session.user;
};

const requestHandler = async (request, response) => {
    const start = Date.now();
    response.on('close', () => logRequest(request, response, Date.now() - start));

    const requestPath = url.parse(request.url, true).pathname;
    request.requestPath = requestPath;

    startSession(request, response);

    if (!/^\/(login|register)/.test(requestPath) && !isAuthenticated(request)) {
        return redirectTo(response, '/login.html');
    }

    try {
        const handler = routes.getHandler(request.method, requestPath);
        if (handler) {
            await handler(request, response);
            return response.end();
        }
        response.statusCode = 404;
    } catch (error) {
        console.error(error);
    }
    response.end();
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
socketIo(httpServer).on('connection', socketIoHandler);;
socketIo(httpsServer).on('connection', socketIoHandler);

const serve = async () => {
    try {
        await sequelize.authenticate();
        createTables();

        httpServer.listen(httpPort, hostname, () => {
            console.info(`Resource Directory: ${resourceBaseDir}`);
            console.info(`Server running at http://${hostname}:${httpPort}/`);
        });
        httpsServer.listen(httpsPort, hostname, () => {
            console.info(`Resource Directory: ${resourceBaseDir}`);
            console.info(`Server running at https://${hostname}:${httpsPort}/`);
        });
    } catch (error) {
        console.error(error);
    }
};

// utils
const isString = value => 'string' === typeof value || value instanceof String;
const isNumber = value => 'number' === typeof value || value instanceof Number;
const isValidLatitude = latitude => isNumber(latitude) && !isNaN(latitude);// && -90 <= latitude && latitude < 90;
const isValidLongitude = longitude => isNumber(longitude) && !isNaN(longitude);// && -180 <= longitude && longitude < 180;
const randomString = length => {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.trunc(Math.random() * characters.length));
    }
    return result;
};
const redirectTo = (response, url) => {
    response.statusCode = 302;
    response.setHeader('Location', url);
    response.end();
};
const passwordHash = password => bcrypt.hash(password, passwordSaltRounds);
const passwordCompare = bcrypt.compare
// path.join('/', '../../..') => '/'
const getResourcePath = (filePath) => path.join(resourceBaseDir, path.join('/', filePath));
const getStoragePath = (filePath) => path.join(storageBaseDir, path.join('/', filePath));

// routes
routes.add('GET', '/', (request, response) => redirectTo(response, 'maps.html'));

routes.add('POST', '/login', async (request, response) => {
    const { username, password } = await new Promise((resolve, reject) => {
        form.parse(request, async (error, fields, files) => {
            if (error) {
                reject(error);
            }
            resolve(fields);
        });
    });

    const user = await User.findOne({ where: { username } });
    if (!user || !await passwordCompare(password, user.password)) {
        return redirectTo(response, '/login.html');
    }

    request.session.user = user;
    redirectTo(response, '/');
});

routes.add('POST', '/register', async (request, response) => {
    const { username, password } = await new Promise((resolve, reject) => {
        form.parse(request, async (error, fields, files) => {
            if (error) {
                reject(error);
            }
            resolve(fields);
        });
    });

    if (!username || !password) {
        return redirectTo(response, '/register.html');
    }

    const user = await User.findOne({ where: { username } });
    if (user) {
        return redirectTo(response, '/register.html');
    }

    request.session.user = await User.create({ username, password: await passwordHash(password) });
    redirectTo(response, '/login.html');
});

routes.add('GET', '/user', (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.write(JSON.stringify({ username: request.session.user.username }))
});

routes.add('GET', '/sse', (request, response) => {
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
});

routes.add('POST', '/upload', (request, response) => {
    form.parse(request, async (error, fields, files) => {
        if (error) {
            console.error(error);
            response.end(error);
            return;
        }

        response.write(JSON.stringify({ fields, files }));

        if (files) for (let file of Object.values(files)) {
            const filePathToSave = getStoragePath(file.name);
            try { await fsAsync.unlink(filePathToSave); } catch (e) { }
            try {
                await fsAsync.rename(file.path, filePathToSave);
            } catch (error) {
                console.error(error);
            }
        };

        response.end();
    });
});

routes.add('GET', '/ip_geolocation', async (request, response) => {
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

});

const locations = [];
routes.add('GET', '/locations', (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const result = [];
    for (let location of locations) result.push({
        lat: location.lat,
        lng: location.lng,
        username: location.user.username,
    });
    response.write(JSON.stringify(result));
});

routes.add('GET', /.*/, async (request, response) => {
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
});

// socket.io events
socketIoEventHandlers['user_added_pin'] = socket => message => {
    const { lat, lng } = message;
    if (!isValidLatitude(lat) || !isValidLongitude(lng)) return;
    const user = socket.session.user;
    locations.push({ lat, lng, user });
    socket.broadcast.emit('add_user_pin', { lat, lng, username: user.username });
};

// serve
serve();
