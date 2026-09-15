const express = require('express');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const app = express();

const cors = require('cors');
app.use(cors());

const data_dir = path.join(__dirname, 'data');
// make dir if not exist
if (!fs.existsSync(data_dir)) fs.mkdirSync(data_dir);

var multer = require('multer');
var forms = multer({ limits: { fieldSize: 100 * 1024 * 1024 } });
app.use(forms.array());

// add compression
const compression = require('compression');
app.use(compression());

const bodyParser = require('body-parser')
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// add rate limit
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

const api_root = process.env.API_ROOT ? process.env.API_ROOT.trim().replace(/\/+$/, '') : '';
// console.log(api_root, process.env);

// add health check
app.get(`${api_root}/health`, (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

app.all(`${api_root}/`, (req, res) => {
    res.send('Hello World!' + `API ROOT = ${api_root}`);
});

app.post(`${api_root}/update`, (req, res) => {
    try {
        const { encrypted, uuid, crypto_type = 'legacy' } = req.body;
        // none of the fields can be empty
        if (!encrypted || !uuid) {
            logger.warn('Bad Request: Missing required fields');
            res.status(400).send('Bad Request');
            return;
        }

        // save encrypted to uuid file with crypto_type
        const file_path = path.join(data_dir, path.basename(uuid) + '.json');
        const content = JSON.stringify({
            encrypted: encrypted,
            crypto_type: crypto_type
        });
        fs.writeFileSync(file_path, content);
        if (fs.readFileSync(file_path) == content)
            res.json({ "action": "done" });
        else
            res.json({ "action": "error" });
    } catch (error) {
        logger.error('update error:', error);
        res.status(500).send('Internal Serverless Error');
    }
});

app.all(`${api_root}/get/:uuid`, (req, res) => {
    try {
        const { uuid } = req.params;
        let { crypto_type, password } = req.query; // 支持通过查询参数指定算法
        // none of the fields can be empty

        if (req.body.password) {
            password = req.body.password;
        }
        if (!uuid) {
            res.status(400).send('Bad Request');
            return;
        }
        // get encrypted from uuid file
        const file_path = path.join(data_dir, path.basename(uuid) + '.json');
        if (!fs.existsSync(file_path)) {
            res.status(404).send('Not Found');
            return;
        }
        const data = JSON.parse(fs.readFileSync(file_path));
        if (!data) {
            res.status(500).send('Internal Serverless Error');
            return;
        } else {
            // 如果传递了password，则返回解密后的数据
            if (password) {
                // 优先使用查询参数指定的算法，其次使用存储的算法，最后使用legacy
                const useCryptoType = crypto_type || data.crypto_type || 'legacy';
                const parsed = cookie_decrypt(uuid, data.encrypted, password, useCryptoType);
                res.json({
                    // 浏览器访问 m.weibo.cn 时实际发送的 Cookie 头（合并所有 bucket）
                    cookie_header: build_browser_cookie_header(parsed.cookie_data, 'm.weibo.cn'),
                    // 插件按域名关键词同步的原始分组（仅供参考）
                    cookie_header_by_keyword: build_cookie_headers_by_domain(parsed.cookie_data, is_weibo_domain),
                    local_storage_data: build_weibo_local_storage(parsed.local_storage_data),
                    update_time: parsed.update_time
                });
            } else {
                res.json(data);
            }
        }
    } catch (error) {
        logger.error('get error:', error);
        res.status(500).send('Internal Serverless Error');
    }
});

// 404 handler
app.use((req, res) => {
    logger.warn(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        error: 'Not Found',
        message: `The requested URL ${req.originalUrl} was not found on this server.`,
        path: req.originalUrl,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// error handler
app.use(function (err, req, res, next) {
    logger.error('Unhandled Error:', err);
    res.status(500).send('Internal Serverless Error');
});

// graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM signal received.');

    // close http server
    server.close(() => {
        logger.info('HTTP server closed.');
    });

    // close cache
    await cache.close();

    // wait for log write
    setTimeout(() => {
        logger.info('Process terminated');
        process.exit(0);
    }, 1000);
});

const port = process.env.PORT || 9088;
app.listen(port, () => {
    logger.info(`Server start on http://localhost:${port}${api_root}`);
});

function is_weibo_domain(domain) {
    return domain.includes('weibo.cn') || domain.includes('weibo.com');
}

function build_cookie_headers_by_domain(cookie_data, domain_filter) {
    if (!cookie_data || typeof cookie_data !== 'object') return {};
    const result = {};
    for (const domain in cookie_data) {
        if (domain_filter && !domain_filter(domain)) continue;
        const cookies = cookie_data[domain];
        if (!Array.isArray(cookies)) continue;
        // 保持插件同步 bucket 的原始顺序（该关键词匹配到的 cookie 列表）
        result[domain] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
    return result;
}

/** 判断 cookie 在请求 host 时是否会被浏览器发送 */
function cookie_applies_to_host(cookie, host) {
    const cd = (cookie.domain || '').replace(/^\./, '');
    return host === cd || host.endsWith('.' + cd);
}

/** 合并所有 bucket，按浏览器访问 host 时的规则拼 Cookie 头 */
function build_browser_cookie_header(cookie_data, host) {
    if (!cookie_data || typeof cookie_data !== 'object') return '';
    const parts = [];
    const seen = new Set();
    for (const domain in cookie_data) {
        if (!is_weibo_domain(domain)) continue;
        const cookies = cookie_data[domain];
        if (!Array.isArray(cookies)) continue;
        for (const cookie of cookies) {
            if (!cookie_applies_to_host(cookie, host) || seen.has(cookie.name)) continue;
            seen.add(cookie.name);
            parts.push(`${cookie.name}=${cookie.value}`);
        }
    }
    return parts.join('; ');
}

function build_weibo_local_storage(local_storage_data) {
    if (!local_storage_data || typeof local_storage_data !== 'object') return {};
    const result = {};
    for (const key in local_storage_data) {
        if (!is_weibo_domain(key)) continue;
        result[key] = local_storage_data[key];
    }
    return result;
}

function cookie_decrypt(uuid, encrypted, password, crypto_type = 'legacy') {
    const CryptoJS = require('crypto-js');

    if (crypto_type === 'aes-128-cbc-fixed') {
        // 新的标准 AES-128-CBC 算法，使用固定 IV
        const hash = CryptoJS.MD5(uuid + '-' + password).toString();
        const the_key = hash.substring(0, 16);
        const fixedIv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000'); // 16字节的0
        const options = {
            iv: fixedIv,
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        };
        // 直接解密原始加密数据
        const decrypted = CryptoJS.AES.decrypt(encrypted, CryptoJS.enc.Utf8.parse(the_key), options).toString(CryptoJS.enc.Utf8);
        const parsed = JSON.parse(decrypted);
        return parsed;
    } else {
        // 原有的 legacy 算法
        const the_key = CryptoJS.MD5(uuid + '-' + password).toString().substring(0, 16);
        const decrypted = CryptoJS.AES.decrypt(encrypted, the_key).toString(CryptoJS.enc.Utf8);
        const parsed = JSON.parse(decrypted);
        return parsed;
    }
}

function cookie_encrypt(uuid, data, password, crypto_type = 'legacy') {
    const CryptoJS = require('crypto-js');
    const data_to_encrypt = JSON.stringify(data);

    if (crypto_type === 'aes-128-cbc-fixed') {
        // 新的标准 AES-128-CBC 算法，使用固定 IV
        const hash = CryptoJS.MD5(uuid + '-' + password).toString();
        const the_key = hash.substring(0, 16);
        const fixedIv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000'); // 16字节的0
        const options = {
            iv: fixedIv,
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        };
        // 使用原始加密数据，不包含 CryptoJS 格式包装
        const encrypted = CryptoJS.AES.encrypt(data_to_encrypt, CryptoJS.enc.Utf8.parse(the_key), options);
        return encrypted.ciphertext.toString(CryptoJS.enc.Base64);
    } else {
        // 原有的 legacy 算法
        const the_key = CryptoJS.MD5(uuid + '-' + password).toString().substring(0, 16);
        const encrypted = CryptoJS.AES.encrypt(data_to_encrypt, the_key).toString();
        return encrypted;
    }
}
