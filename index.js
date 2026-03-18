require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------
// [1] PostgreSQL DB 연결 설정 (Railway 내부 DB 사용)
// ---------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Railway에서 제공하는 환경변수
});

// 테이블 추상적 정의 (서버 시작 시 테이블이 없으면 생성)
const initDB = async () => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS user_files (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(100) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_type VARCHAR(50), -- 'ai_log' 또는 'map'
      file_path TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    await pool.query(createTableQuery);
    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("DB Initialization error:", err);
  }
};
initDB();

// ---------------------------------------------------------
// [2] Multer 설정 (동적 폴더 생성 및 저장 로직)
// ---------------------------------------------------------
// Railway에서 Volume을 마운트할 기본 경로 (로컬에서는 현재 폴더의 /uploads)
const BASE_UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 클라이언트가 폼 데이터로 전달한 userId 추출
    const userId = req.body.userId; 
    
    if (!userId) {
      return cb(new Error("유저 ID가 제공되지 않았습니다. (userId)"));
    }

    // 파일명이 'ai'로 시작하는지 확인
    const isAiFile = file.originalname.toLowerCase().startsWith('ai');
    
    // 접두어에 따라 서브 폴더 결정
    const subFolder = isAiFile ? 'ai_log' : 'map';
    
    // 최종 저장 폴더 경로: /uploads/{userId}/{subFolder}
    const dirPath = path.join(BASE_UPLOAD_DIR, userId, subFolder);

    // 폴더가 없으면 재귀적으로 생성 (fs.mkdirSync의 recursive 옵션 사용)
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    cb(null, dirPath);
  },
  filename: (req, file, cb) => {
    // 파일 이름 충돌 방지를 위해 현재 시간(타임스탬프)을 앞에 붙임
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// ---------------------------------------------------------
// [3] API 엔드포인트 구현
// ---------------------------------------------------------

/**
 * 1. 파일 업로드 API
 * - 클라이언트 측 요청: multipart/form-data
 * - 필드: userId (텍스트), file (파일 객체)
 */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { userId } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "파일이 업로드되지 않았습니다." });
    }

    const isAiFile = file.originalname.toLowerCase().startsWith('ai');
    const fileType = isAiFile ? 'ai_log' : 'map';

    // 나중에 사용할 DB에 추상적 테이블 정보 저장
    const insertQuery = `
      INSERT INTO user_files (user_id, file_name, file_type, file_path) 
      VALUES ($1, $2, $3, $4) RETURNING *;
    `;
    const values = [userId, file.filename, fileType, file.path];
    const dbResult = await pool.query(insertQuery, values);

    res.status(200).json({
      message: "파일 업로드 및 분류가 완료되었습니다.",
      folderType: fileType,
      fileInfo: dbResult.rows[0]
    });

  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ error: "서버 처리 중 오류가 발생했습니다." });
  }
});

/**
 * 2. 파일 다운로드 API
 * - 요청 URL 형식: GET /api/download/{userId}/{fileType}/{fileName}
 * - fileType은 'ai_log' 또는 'map'
 */
app.get('/api/download/:userId/:fileType/:fileName', (req, res) => {
  const { userId, fileType, fileName } = req.params;

  // 보안 조치: 상위 디렉토리 접근 차단
  if (userId.includes('..') || fileType.includes('..') || fileName.includes('..')) {
    return res.status(400).json({ error: "잘못된 파일 경로입니다." });
  }

  const filePath = path.join(BASE_UPLOAD_DIR, userId, fileType, fileName);

  if (fs.existsSync(filePath)) {
    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error("Download error:", err);
        res.status(500).json({ error: "파일 다운로드 중 오류가 발생했습니다." });
      }
    });
  } else {
    res.status(404).json({ error: "파일을 찾을 수 없습니다." });
  }
});

// ---------------------------------------------------------
// [4] 서버 실행
// ---------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
