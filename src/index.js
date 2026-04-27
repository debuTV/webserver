const express = require('express')
const log4js=require('log4js')
log4js.configure({
    appenders: { 
        OUT: { type: 'stdout' },
        LOG: { type: 'file', filename: 'log\\log.log' },
        ERROR: { type: 'file', filename: 'log\\error.log' }
    },
    categories: {
        default: { appenders: ['OUT','LOG'], level: 'info' },
        error: { appenders: ['OUT','ERROR'], level: 'error' }
    }
});

const logERROR = log4js.getLogger('error');
const logLOG = log4js.getLogger('default');
const app = express()

app.get('/', (req, res) => {
    logLOG.info('Received GET request');
    res.send('Hello World! 数据'+JSON.stringify(req.query));
});
app.post('/submit', (req, res) => {
    logLOG.info('Received POST request');
    res.send('提交成功！数据'+JSON.stringify(req.body));
});

app.listen(8888, () => {
    logLOG.info('Server is running on port 8888');
    console.log("端口号：8888");
});