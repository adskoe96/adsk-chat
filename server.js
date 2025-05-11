const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'bruh_password',
  database: 'chat_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function initializeDB() {
  const conn = await pool.getConnection();
  await conn.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  conn.release();
}

app.use(express.static('public'));

io.on('connection', async (socket) => {
  console.log('Новое подключение');
  
  try {
    const [rows] = await pool.query(
      'SELECT username, message, UNIX_TIMESTAMP(created_at) * 1000 AS timestamp FROM messages ORDER BY created_at DESC LIMIT 50'
    );
    socket.emit('history', rows.reverse());
  } catch (err) {
    console.error('Ошибка загрузки истории:', err);
  }

  socket.on('message', async (data) => {
    try {
      if (!data.username || !data.message) return;
      const username = data.username.toString().substring(0, 255);
      const message = data.message.toString().substring(0, 1000);

      await pool.query(
        'INSERT INTO messages (username, message) VALUES (?, ?)',
        [username, message]
      );

      io.emit('message', {
        username: username,
        message: message,
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('Ошибка сохранения сообщения:', err);
    }
  });
});

initializeDB().then(() => {
  http.listen(3000, () => {
    console.log('Сервер запущен на http://localhost:3000');
  });
});