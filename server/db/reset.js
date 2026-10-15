// Recreates all tables and loads demo data. Usage: npm run db:reset
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { prepareBucket } from '../src/storage.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
await pool.query(schema);

const hash = await bcrypt.hash('Password123!', 10);
await pool.query(
  `INSERT INTO staff_user (full_name, email, role, password_hash) VALUES
   ('Sarah Wilson', 'sarah@ric.test', 'recruiter', $1),
   ('Michael Tan',  'michael@ric.test', 'recruiter', $1),
   ('Priya Manager','manager@ric.test', 'manager', $1)`,
  [hash],
);

const programs = [
  ['Graduate Certificate in Artificial Intelligence', 'Artificial Intelligence', 4, { IELTS: 6.5, PTE: 58, TOEFL: 79 }],
  ['Diploma of Data Science', 'Data Science', 1, { IELTS: 6.0, PTE: 50, TOEFL: 60 }],
  ['Certificate in Digital Marketing', 'Digital Marketing', 1, { IELTS: 5.5, PTE: 42, TOEFL: 46 }],
  ['Diploma of Secure Systems Engineering', 'Secure Systems', 2, { IELTS: 6.0, PTE: 50, TOEFL: 60 }],
];
for (const [name, discipline, level, lang] of programs) {
  const { rows } = await pool.query(
    `INSERT INTO program (name, discipline, brochure_url, min_qualification_level, language_requirements)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, discipline, `https://example.com/brochures/${discipline.toLowerCase().replace(/ /g, '-')}.pdf`, level, lang],
  );
  await pool.query(
    `INSERT INTO intake (program_id, name, start_date) VALUES
     ($1, 'February 2027', '2027-02-22'), ($1, 'July 2027', '2027-07-19')`,
    [rows[0].id],
  );
  await pool.query(
    `INSERT INTO program_document_type (program_id, document_type) VALUES
     ($1, 'Passport or photo ID'), ($1, 'Academic transcript'), ($1, 'English test result')`,
    [rows[0].id],
  );
}

const storage = await prepareBucket({ empty: true });
console.log(`File storage: ${storage === 'supabase' ? 'Supabase Storage (bucket emptied)' : 'local database table'}`);
console.log('Database reset. Staff logins: sarah@ric.test, michael@ric.test, manager@ric.test / Password123!');
await pool.end();
