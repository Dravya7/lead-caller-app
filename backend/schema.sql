CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'employee' -- 'employee' or 'manager'
);

CREATE TABLE IF NOT EXISTS upload_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uploaded_by INTEGER REFERENCES employees(id),
  filename TEXT,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES upload_batches(id),
  employee_id INTEGER REFERENCES employees(id),
  customer_name TEXT,
  phone_number TEXT NOT NULL,
  extra_data TEXT, -- JSON string of other excel columns
  status TEXT DEFAULT 'not_called', -- not_called, called, callback, rejected, interested
  call_reason TEXT,
  called_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  employee_id INTEGER REFERENCES employees(id),
  status TEXT,
  reason TEXT,
  called_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
