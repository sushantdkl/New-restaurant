ALTER TABLE users ADD COLUMN IF NOT EXISTS absence_daily_rate DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS salary_month TEXT;
CREATE TABLE IF NOT EXISTS staff_salary_terms (
  id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  effective_month TEXT NOT NULL, salary DOUBLE PRECISION NOT NULL CHECK (salary >= 0),
  created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(employee_id, effective_month)
);
CREATE TABLE IF NOT EXISTS staff_salary_adjustments (
  id SERIAL PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  salary_month TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('absence', 'advance_waiver', 'absence_waiver')),
  amount DOUBLE PRECISION NOT NULL CHECK (amount > 0), absent_days DOUBLE PRECISION DEFAULT 0,
  daily_rate DOUBLE PRECISION DEFAULT 0, note TEXT NOT NULL, created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_staff_salary_adjustments_employee_month ON staff_salary_adjustments(employee_id, salary_month);
INSERT INTO staff_salary_terms (employee_id, effective_month, salary)
SELECT id, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kathmandu', 'YYYY-MM'), salary
FROM users WHERE salary IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO system_settings (setting_key, setting_value)
VALUES ('payroll_absence_deductions_enabled', 'false') ON CONFLICT DO NOTHING;
