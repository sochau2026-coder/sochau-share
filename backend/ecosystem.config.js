module.exports = {
    apps: [
        {
            name: 'sochau-backend',
            script: 'server.js',
            cwd: '/opt/sochau-share/backend',
            instances: 1,
            autorestart: true,
            watch: false,
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
                CLIENT_URL: 'https://share.sochau.cloud',
            },
            error_file: '/var/log/sochau-backend-error.log',
            out_file: '/var/log/sochau-backend-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
        },
    ],
};
