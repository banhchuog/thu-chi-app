require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({ dest: 'uploads/' });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Kết nối PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Tạo bảng nếu chưa có
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS transactions (
            id BIGINT PRIMARY KEY,
            date VARCHAR(20),
            type VARCHAR(10),
            subject VARCHAR(255),
            amount NUMERIC(15,2),
            currency VARCHAR(10),
            note TEXT,
            created_by VARCHAR(100)
        )
    `);
    // Thêm cột created_by nếu DB cũ chưa có
    await pool.query(`
        ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by VARCHAR(100)
    `);
    // Đổi kiểu amount sang NUMERIC để lưu được số thập phân (USD)
    try {
        await pool.query(`ALTER TABLE transactions ALTER COLUMN amount TYPE NUMERIC(15,2) USING amount::NUMERIC(15,2)`);
    } catch(e) { /* Đã là NUMERIC rồi, bỏ qua */ }
    // Tạo bảng quản lý API key
    await pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            key VARCHAR(64) UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            last_used TIMESTAMP
        )
    `);
    console.log('Database sẵn sàng.');
}

// API lấy danh sách giao dịch
app.get('/api/transactions', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions ORDER BY date DESC, id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Lỗi truy vấn database' });
    }
});

// API thêm giao dịch mới
app.post('/api/transactions', async (req, res) => {
    try {
        const { date, type, subject, amount, currency, note, created_by } = req.body;
        const id = Date.now();
        await pool.query(
            'INSERT INTO transactions (id, date, type, subject, amount, currency, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [id, date, type, subject, amount, currency, note || '', created_by || '']
        );
        res.json({ id, date, type, subject, amount, currency, note, created_by });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi thêm giao dịch' });
    }
});

// API sửa giao dịch
app.put('/api/transactions/:id', async (req, res) => {
    try {
        const { date, type, subject, amount, currency, note } = req.body;
        const id = parseInt(req.params.id);
        await pool.query(
            'UPDATE transactions SET date=$1, type=$2, subject=$3, amount=$4, currency=$5, note=$6 WHERE id=$7',
            [date, type, subject, amount, currency, note || '', id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi cập nhật giao dịch' });
    }
});

// API xoá giao dịch
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM transactions WHERE id=$1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Lỗi xoá giao dịch' });
    }
});

// ===== API KEY MANAGEMENT =====
async function validateApiKey(req, res, next) {
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (!key) return res.status(401).json({ error: 'Thiếu API key. Truyền qua header X-Api-Key hoặc ?api_key=...' });
    try {
        const result = await pool.query('SELECT id FROM api_keys WHERE key=$1', [key]);
        if (result.rows.length === 0) return res.status(403).json({ error: 'API key không hợp lệ' });
        await pool.query('UPDATE api_keys SET last_used=NOW() WHERE key=$1', [key]);
        next();
    } catch(err) {
        res.status(500).json({ error: 'Lỗi xác thực' });
    }
}

// External read-only endpoint yêu cầu API key
app.get('/api/v1/transactions', validateApiKey, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions ORDER BY date DESC, id DESC');
        res.json(result.rows);
    } catch(err) {
        res.status(500).json({ error: 'Lỗi truy vấn database' });
    }
});

// Lấy danh sách API key
app.get('/api/keys', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, key, created_at, last_used FROM api_keys ORDER BY created_at DESC');
        res.json(result.rows);
    } catch(err) {
        res.status(500).json({ error: 'Lỗi lấy danh sách key' });
    }
});

// Tạo API key mới
app.post('/api/keys', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Cần đặt tên cho key' });
        const key = crypto.randomBytes(32).toString('hex');
        const result = await pool.query(
            'INSERT INTO api_keys (name, key) VALUES ($1,$2) RETURNING id, name, key, created_at',
            [name.trim(), key]
        );
        res.json(result.rows[0]);
    } catch(err) {
        res.status(500).json({ error: 'Lỗi tạo key' });
    }
});

// Xoá API key
app.delete('/api/keys/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM api_keys WHERE id=$1', [parseInt(req.params.id)]);
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ error: 'Lỗi xoá key' });
    }
});

// API upload nhiều ảnh và dùng AI quét, tự động lưu
app.post('/api/upload-bulk', upload.array('images'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Không có ảnh nào được tải lên' });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const results = [];
        const errors = [];
        const created_by = req.body.created_by || 'Không rõ';

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const imagePath = file.path;

            try {
                const imageBase64 = fs.readFileSync(imagePath).toString('base64');

                const prompt = `
                Phân tích hình ảnh hoá đơn hoặc màn hình chuyển khoản này và trích xuất các thông tin sau dưới dạng JSON:
                {
                    "date": "Ngày phát sinh (định dạng YYYY-MM-DD)",
                    "subject": "Đối tượng (Tên người gửi/nhận hoặc cửa hàng)",
                    "amount": "Số tiền dướng dạng số thuần, giữ nguyên phần thập phân nếu có (ví dụ: 24.99 hoặc 1500000, không dùng dấu phẩy phân cách nhóm số)",
                    "currency": "Loại tiền tệ (VND hoặc USD)",
                    "type": "Bên nhận/chuyển (Thu hoặc Chi)",
                    "note": "Ghi chú thêm (Nội dung chuyển khoản hoặc chi tiết hoá đơn)"
                }
                Chỉ trả về JSON hợp lệ, không có markdown hay text nào khác.
                `;

                const result = await model.generateContent([
                    prompt,
                    { inlineData: { data: imageBase64, mimeType: file.mimetype } }
                ]);

                const jsonStr = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
                const extracted = JSON.parse(jsonStr);

                const typeLower = (extracted.type || '').toLowerCase();
                const type = (typeLower.includes('thu') || typeLower.includes('nhận')) ? 'Thu' : 'Chi';
                const currency = (extracted.currency || '').toUpperCase().includes('USD') ? 'USD' : 'VND';

                // Parse số tiền: giữ dấu thập phân nếu là USD, loại bỏ nếu là VND
                function parseAmount(raw) {
                    const str = String(raw || '0').replace(/[^0-9.,]/g, '');
                    // Nếu kết thúc bằng dấu phẩy hoặc chấm rồi 1-2 số (thập phân thật sự)
                    const decMatch = str.match(/[.,](\d{1,2})$/);
                    if (decMatch) {
                        const dec = decMatch[1];
                        const intPart = str.slice(0, str.length - decMatch[0].length).replace(/[.,]/g, '');
                        return parseFloat(`${intPart}.${dec}`) || 0;
                    }
                    return parseInt(str.replace(/[.,]/g, ''), 10) || 0;
                }
                const amount = parseAmount(extracted.amount);
                const id = Date.now() + i;

                await pool.query(
                    'INSERT INTO transactions (id, date, type, subject, amount, currency, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                    [id, extracted.date || new Date().toISOString().split('T')[0], type, extracted.subject || 'Không rõ', amount, currency, extracted.note || '', created_by]
                );

                results.push({ id, type, subject: extracted.subject, amount, currency });
            } catch (err) {
                console.error('Lỗi xử lý ảnh:', file.originalname, err);
                errors.push(file.originalname);
            } finally {
                if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
            }
        }

        res.json({ success: true, results, errors });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Lỗi hệ thống khi xử lý ảnh' });
    }
});

initDB().then(() => {
    app.listen(port, () => {
        console.log(`Server đang chạy tại http://localhost:${port}`);
    });
}).catch(err => {
    console.error('Lỗi khởi động:', err);
    process.exit(1);
});
