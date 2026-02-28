require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const XLSX = require('xlsx');

// Tỷ giá USD → VND (có thể đặt biến môi trường USD_RATE để ghi đè)
const USD_TO_VND = parseInt(process.env.USD_RATE || '25500');

// Convert số tiền về VND
function normalizeToVND(row) {
    const r = { ...row };
    if ((r.currency || '').toUpperCase() === 'USD') {
        r.amount_original = parseFloat(r.amount);
        r.currency_original = 'USD';
        r.amount = Math.round(parseFloat(r.amount) * USD_TO_VND);
        r.currency = 'VND';
        r.usd_rate_used = USD_TO_VND;
    }
    return r;
}

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
    // Thêm cột source (nguồn giao dịch)
    await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source VARCHAR(100) DEFAULT 'Thủ công'`);
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
        const { date, type, subject, amount, currency, note, created_by, source } = req.body;
        const id = Date.now();
        await pool.query(
            'INSERT INTO transactions (id, date, type, subject, amount, currency, note, created_by, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [id, date, type, subject, amount, currency, note || '', created_by || '', source || 'Thủ công']
        );
        res.json({ id, date, type, subject, amount, currency, note, created_by, source });
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

// API đọc file xlsx - trả về danh sách để user xem trước
app.post('/api/parse-xlsx', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Không có file' });
    try {
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        const items = [];
        const skipped = [];

        for (const row of rows) {
            if (!Array.isArray(row)) continue;

            // Bỏ hàng trống hoàn toàn
            const nonEmpty = row.filter(c => c !== '' && c !== null && c !== undefined);
            if (nonEmpty.length < 2) continue;

            // Tìm số tiền: ưu tiên cell kiểu number >= 10000, nếu không thì parse string
            let amount = 0;
            let amountColIdx = -1;
            for (let ci = 0; ci < row.length; ci++) {
                const cell = row[ci];
                let n = 0;
                if (typeof cell === 'number' && cell > 0) {
                    n = cell;
                } else if (typeof cell === 'string') {
                    const s = cell.replace(/[.\s,]/g, '').replace(/[đdₓ₫$%]/gi, '');
                    n = parseFloat(s) || 0;
                }
                if (n >= 10000 && n > amount) {
                    amount = n;
                    amountColIdx = ci;
                }
            }
            if (!amount) { skipped.push(row.slice(0,5).join(' | ')); continue; }

            // Lấy text làm subject: bỏ cột số thứ tự (chỉ là số nhỏ), bỏ cột số tiền, lấy text đầu tiên còn lại
            const textCells = [];
            for (let ci = 0; ci < row.length; ci++) {
                if (ci === amountColIdx) continue;
                const cell = row[ci];
                const s = String(cell ?? '').trim();
                if (!s) continue;
                // Bỏ cột chỉ là số (STT) hoặc % hoặc quá ngắn
                if (/^\d{1,3}$/.test(s)) continue;
                if (/^[\d.,]+%?$/.test(s.replace(/\s/g,''))) continue;
                textCells.push(s);
            }
            if (!textCells.length) { skipped.push('no-text: ' + row.slice(0,5).join(' | ')); continue; }

            const subject = textCells[0];
            const note = textCells.slice(1).join(' | ');
            const combined = row.map(c => String(c ?? '').toLowerCase()).join(' ');

            // Bỏ qua hàng tổng / tiêu đề
            if (/^tổng|^total|^chi phí|^hạng mục|^đối tượng|^nội dung|^stt$/i.test(subject.trim())) {
                skipped.push('header/total: ' + subject); continue;
            }

            const isPersonnel = /lương|thù lao|nhân sự|đạo diễn|diễn viên|âm thanh|ánh sáng|\bbts\b|quay phim|dựng phim|kịch bản|thumbnail/i.test(combined);

            items.push({ subject, note, amount, isPersonnel });
        }

        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.log(`XLSX parse: ${items.length} items, ${skipped.length} skipped`);
        res.json({ items, debug_skipped: skipped.slice(0, 10) });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error('Lỗi parse xlsx:', err);
        res.status(500).json({ error: 'Lỗi đọc file: ' + err.message });
    }
});

// API import xlsx sau khi user đã xác nhận
app.post('/api/import-xlsx', async (req, res) => {
    try {
        const { items, date, source, created_by } = req.body;
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Không có dữ liệu' });
        let count = 0;
        for (let i = 0; i < items.length; i++) {
            const { subject, note, amount } = items[i];
            const id = Date.now() + i * 10;
            await pool.query(
                'INSERT INTO transactions (id,date,type,subject,amount,currency,note,created_by,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [id, date, 'Chi', subject, amount, 'VND', note || '', created_by || 'Import', source || 'Chi phí sản xuất']
            );
            count++;
        }
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== IMPORT TEMPLATE HÀNG LOẠT =====
// Helper parse ngày từ Excel: Date object, serial number, YYYY-MM-DD, DD/MM/YYYY
function parseExcelDate(rawCell, fallback) {
    if (!rawCell && rawCell !== 0) return fallback;
    if (rawCell instanceof Date && !isNaN(rawCell)) {
        const y = rawCell.getFullYear();
        const m = String(rawCell.getMonth() + 1).padStart(2, '0');
        const d = String(rawCell.getDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }
    const s = String(rawCell).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(s)) {
        const p = s.split(/[\/\-]/);
        return p[2] + '-' + p[1].padStart(2, '0') + '-' + p[0].padStart(2, '0');
    }
    // Excel serial number (46023 = 2026-01-01)
    if (/^\d{5}$/.test(s)) {
        const d = new Date(Math.round((parseFloat(s) - 25569) * 86400 * 1000));
        if (!isNaN(d)) return d.toISOString().split('T')[0];
    }
    return fallback;
}

// Parse file CSV/XLSX theo cột header chuẩn: Ngày | Loại | Đối tượng | Số tiền | Tiền tệ | Ghi chú | Người thực hiện
app.post('/api/parse-template', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Không có file' });
    try {
        const wb = XLSX.readFile(req.file.path);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        if (rows.length < 2) return res.json({ items: [], errors: [] });

        // Map header → column index (chấp nhận tiếng Việt + tiếng Anh)
        const headers = rows[0].map(h => String(h).trim().toLowerCase());
        const col = {
            date:       headers.findIndex(h => /ngày|date/.test(h)),
            type:       headers.findIndex(h => /^loại|^type/.test(h)),
            subject:    headers.findIndex(h => /đối tượng|subject|hạng mục/.test(h)),
            amount:     headers.findIndex(h => /số tiền|amount/.test(h)),
            currency:   headers.findIndex(h => /tiền tệ|currency/.test(h)),
            note:       headers.findIndex(h => /ghi chú|note/.test(h)),
            created_by: headers.findIndex(h => /người|created_by|thực hiện/.test(h)),
        };

        const items = [], errors = [];
        const today = new Date().toISOString().split('T')[0];

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row.filter(c => c !== '').length === 0) continue;

            const get = (idx) => idx >= 0 ? String(row[idx] ?? '').trim() : '';
            const subject = get(col.subject);
            const amountRaw = col.amount >= 0 ? row[col.amount] : '';
            let amount = typeof amountRaw === 'number'
                ? amountRaw
                : parseFloat(String(amountRaw).replace(/[.\s]/g,'').replace(',','.').replace(/[đdₓ₫$%a-zA-Z]/gi,'')) || 0;

            if (!subject) { errors.push(`Hàng ${i+1}: thiếu đối tượng`); continue; }
            if (!amount)  { errors.push(`Hàng ${i+1}: thiếu hoặc sai số tiền`); continue; }

            // Parse ngày: xử lý Date object từ xlsx, serial number, string
            const date = parseExcelDate(col.date >= 0 ? row[col.date] : '', today);

            const typeRaw = get(col.type).toLowerCase();
            const type = typeRaw.includes('thu') ? 'Thu' : 'Chi';
            const currencyRaw = get(col.currency).toUpperCase();
            const currency = currencyRaw === 'USD' ? 'USD' : 'VND';
            const note = get(col.note);
            const created_by = get(col.created_by);

            items.push({ date, type, subject, amount, currency, note, created_by });
        }

        console.log(`Template parse: ${items.length} items, ${errors.length} errors`);
        res.json({ items, errors });
    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Lỗi đọc file: ' + err.message });
    }
});

// Import sau khi user xác nhận - trả về insertedIds để rollback nếu cần
app.post('/api/import-template', async (req, res) => {
    try {
        const { items, default_created_by, source } = req.body;
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Không có dữ liệu' });
        let count = 0;
        const insertedIds = [];
        for (let i = 0; i < items.length; i++) {
            const { date, type, subject, amount, currency, note, created_by } = items[i];
            const id = Date.now() + i * 10;
            await pool.query(
                'INSERT INTO transactions (id,date,type,subject,amount,currency,note,created_by,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [id, date, type || 'Chi', subject, amount, currency || 'VND', note || '',
                 created_by || default_created_by || 'Import', source || 'Import hàng loạt']
            );
            insertedIds.push(String(id));
            count++;
        }
        res.json({ success: true, count, insertedIds });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rollback: xoá hàng loạt theo danh sách ID
app.post('/api/transactions/rollback', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Không có IDs' });
        const result = await pool.query('DELETE FROM transactions WHERE id = ANY($1::bigint[])', [ids]);
        res.json({ success: true, deleted: result.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
// Trả về tất cả giao dịch, USD tự động đổi sang VND theo tỷ giá USD_RATE (mặc định 25500)
app.get('/api/v1/transactions', validateApiKey, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM transactions ORDER BY date DESC, id DESC');
        res.json(result.rows.map(normalizeToVND));
    } catch(err) {
        res.status(500).json({ error: 'Lỗi truy vấn database' });
    }
});

// Thêm 1 giao dịch qua API key (từ app ngoài)
app.post('/api/v1/transactions', validateApiKey, async (req, res) => {
    try {
        const { date, type, subject, amount, currency, note, created_by, source } = req.body;
        const id = Date.now();
        await pool.query(
            'INSERT INTO transactions (id,date,type,subject,amount,currency,note,created_by,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [id, date, type || 'Thu', subject, amount, currency || 'VND', note || '', created_by || 'API', source || 'Dịch vụ online']
        );
        res.json({ success: true, id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import hàng loạt qua API key (doanh thu từ app bán dịch vụ online)
app.post('/api/v1/transactions/bulk', validateApiKey, async (req, res) => {
    try {
        const { transactions, source } = req.body;
        if (!Array.isArray(transactions) || !transactions.length)
            return res.status(400).json({ error: 'Cần truyền mảng transactions' });
        let count = 0;
        const errors = [];
        for (let i = 0; i < transactions.length; i++) {
            const tx = transactions[i];
            try {
                const id = Date.now() + i;
                await pool.query(
                    'INSERT INTO transactions (id,date,type,subject,amount,currency,note,created_by,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING',
                    [id, tx.date, tx.type || 'Thu', tx.subject, tx.amount, tx.currency || 'VND', tx.note || '', tx.created_by || 'API', tx.source || source || 'Dịch vụ online']
                );
                count++;
            } catch(e) { errors.push(e.message); }
        }
        res.json({ success: true, count, errors });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        const uploadSource = req.body.source || 'AI Quét';

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const imagePath = file.path;

            try {
                const imageBase64 = fs.readFileSync(imagePath).toString('base64');

                const today = new Date();
                const currentYear = today.getFullYear();
                const currentMonth = String(today.getMonth() + 1).padStart(2, '0');
                const currentDateStr = today.toISOString().split('T')[0];

                const prompt = `
                Hôm nay là ngày ${currentDateStr} (năm ${currentYear}, tháng ${currentMonth}).
                Phân tích hình ảnh hoá đơn hoặc màn hình chuyển khoản này và trích xuất các thông tin sau dưới dạng JSON:
                {
                    "date": "Ngày phát sinh (định dạng YYYY-MM-DD). QUAN TRỌNG: Nếu hình chỉ có ngày/tháng mà không rõ năm, hãy dùng năm ${currentYear}. Nếu hình có 2 chữ số năm (ví dụ 26), hãy hiểu là 20XX phù hợp nhất với ngày hôm nay (${currentYear}).",
                    "subject": "Đối tượng (Tên người gửi/nhận hoặc cửa hàng)",
                    "amount": "Số tiền dưới dạng số thuần, giữ nguyên phần thập phân nếu có (ví dụ: 24.99 hoặc 1500000, không dùng dấu phẩy phân cách nhóm số)",
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

                // Validate và sửa năm nếu AI trả về sai
                let extractedDate = extracted.date || currentDateStr;
                if (extractedDate && extractedDate.length >= 4) {
                    const yearInDate = parseInt(extractedDate.substring(0, 4));
                    if (Math.abs(yearInDate - currentYear) > 1) {
                        // Năm lệch quá 1 năm → thay bằng năm hiện tại
                        extractedDate = currentYear + extractedDate.substring(4);
                    }
                }

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
                    'INSERT INTO transactions (id, date, type, subject, amount, currency, note, created_by, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                    [id, extractedDate, type, extracted.subject || 'Không rõ', amount, currency, extracted.note || '', created_by, uploadSource]
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
