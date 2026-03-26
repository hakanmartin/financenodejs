import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Test the connection
pool.connect((err, client, release) => {
    if (err) {
        return console.error('Veritabanına bağlanırken bir hata oluştu:', err.stack);
    }
    console.log('PostgreSQL veritabanına başarıyla bağlanıldı.');
    release();
});

export const query = (text, params) => pool.query(text, params);
export default pool;
