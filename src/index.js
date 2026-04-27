const express = require('express')
const log=require('log4js')
log.configure({
    appenders: { 
        OUT: { type: 'stdout' },
        LOG: { type: 'file', filename: 'log.log' },
        ERROR: { type: 'file', filename: 'error.log' }
    },
    categories: {
        default: { appenders: ['OUT','LOG'], level: 'info' },
        error: { appenders: ['OUT','ERROR'], level: 'error' }
    }
});

const adapter = log.getLogger('cheese');
const app = express()
app.get('/', (req, res) => {
    adapter.info('Received GET request');
    res.send('Hello World! 数据'+JSON.stringify(req.query));
});
app.post('/submit', (req, res) => {
    adapter.info('Received POST request');
    res.send('提交成功！数据'+JSON.stringify(req.body));
});
app.listen(8888, () => {
    adapter.info('Server is running on port 8888');
    console.log("端口号：8888");
});