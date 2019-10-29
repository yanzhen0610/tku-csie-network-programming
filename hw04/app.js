const fs = require('fs');
const path = require('path');
const request = require('request');

fs.readdir(__dirname, {withFileTypes: true}, (error, files) => {
    if (error) {
        console.log(error);
        return;
    }
    
    const formData = new Object();
    const promises = new Array();

    files.forEach(file => {
        if (file.isFile()) {
            promises.push(new Promise((resolve, reject) => {
                fs.readFile(path.join(__dirname, file.name), (error, data) => {
                    if (error) {
                        reject(error);
                    }

                    resolve({
                        name: file.name,
                        content: data,
                    });
                })
            }));
        }
    });

    Promise.all(promises).then((values) => {
        values.forEach((value) => {
            formData[value.name] = value.content;
        });

        request.post('https://localhost:8081/upload', {url: 'https://localhost:8081/upload', formData, strictSSL: false}, (error, response, body) => {
            if (error) {
                console.error(error);
                return;
            }
            console.log('post files to `https://localhost:8081/upload` successful', body);
            console.log(response);
        });
    });
});
