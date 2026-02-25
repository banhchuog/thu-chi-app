require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const fs = require('fs');
const cors = require('cors');

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
            amount BIGINT,
            currency VARCHAR(10),
            note TEXT
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
        const { date, type, subject, amount, currency, note } = req.body;
        const id = Date.now();
        await pool.query(
            'INSERT INTO transactions (id, date, type, subject, amount, currency, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, date, type, subject, amount, currency, note || '']
        );
        res.json({ id, date, type, subject, amount, currency, note });
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

// API upload nhiều ảnh và dùng AI quét, tự động lưu
app.post('/api/upload-bulk', upload.array('images'), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'Không có ảnh nào được tải lên' });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const results = [];
        const errors = [];

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
                    "amount": "Số tiền (chỉ để số, ví dụ: 100000)",
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
                const amount = extracted.amount ? extracted.amount.toString().replace(/[^0-9]/g, '') : 0;
                const currency = (extracted.currency || '').toUpperCase().includes('USD') ? 'USD' : 'VND';
                const id = Date.now() + i;

                await pool.query(
                    'INSERT INTO transactions (id, date, type, subject, amount, currency, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [id, extracted.date || new Date().toISOString().split('T')[0], type, extracted.subject || 'Không rõ', amount, currency, extracted.note || '']
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
