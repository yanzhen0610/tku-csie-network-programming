#! /bin/sh

if [ -f 'RootCA.crt' ] && [ -f 'RootCA.key' ] && [ -f 'RootCA.pem' ]
then
    echo 'Root CA exists'
else
    openssl req -x509 -nodes -sha512 -new -days 36500 -newkey rsa:4096 -keyout RootCA.key -out RootCA.pem -subj '/CN=localhost Root CA'
    openssl x509 -outform pem -in RootCA.pem -out RootCA.crt
fi

cat > localhost.ext << EOF
subjectAltName = @alt_names
[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

openssl req -new -nodes -newkey rsa:4096 -keyout localhost.key -out localhost.csr -subj '/CN=localhost'
openssl x509 -req -sha512 -days 36500 -in localhost.csr -CA RootCA.pem -CAkey RootCA.key -CAcreateserial -extfile localhost.ext -out localhost.crt
