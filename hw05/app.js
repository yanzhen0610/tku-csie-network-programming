const net = require('net');
const dns = require('dns');
const process = require('process');
const Traceroute = require('nodejs-traceroute');

const timeout = 5 * 1000;

const traceroute = (host, callback) => {
    const promises = new Array();
    const hops = new Object();
    
    const tracer = new Traceroute();

    let setTimeoutId = null;
    
    tracer.on('pid', (pid) => {
        setTimeoutId = setTimeout(() => {
            process.kill(pid, process.SIGTERM);
        }, timeout);
    });
    
    tracer.on('destination', (destination) => {
    });
    
    tracer.on('hop', (hop) => {
        const ip = hop.ip;
        if (net.isIPv4(ip) || net.isIPv6(ip)) {
            const promise = new Promise((resolve, reject) => {
                dns.reverse(hop.ip, (error, hostnames) => {
                    if (error) {
                        hops[hop.hop] = hop;
                        reject(error);
                        return;
                    }
                    hops[hop.hop] = {
                        ...hop,
                        hostnames,
                    };
                    resolve(hostnames);
                });
            });
    
            promise.then(() => {}).catch(() => {});
    
            promises.push(promise);
        } else {
            hops[hop.hop] = hop;
        }
    });
    
    tracer.on('close', (code) => {
        if (setTimeoutId) clearTimeout(setTimeoutId);
        if (callback) callback(hops)
    });
    
    tracer.trace(host);
};

traceroute('190.37.198.2', console.log);
traceroute('72.27.189.3', console.log);
traceroute('169.1.102.4', console.log);
traceroute('178.74.25.5', console.log);
traceroute('github.com', console.log);
