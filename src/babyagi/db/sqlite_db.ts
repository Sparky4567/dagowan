import { Database } from "bun:sqlite";
import type { FunctionMetadata, FunctionVersion, ExecutionLog, VectorDocument } from "../types";

export class SQLiteDB {
  private db: Database;

  constructor(dbPath: string = "babyagi.sqlite") {
    this.db = new Database(dbPath, { create: true });
    this.initTables();
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS functions (
        name TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        description TEXT,
        imports TEXT,
        dependencies TEXT,
        key_dependencies TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS function_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        function_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        code TEXT NOT NULL,
        imports TEXT,
        dependencies TEXT,
        key_dependencies TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(function_name) REFERENCES functions(name)
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS execution_logs (
        log_id TEXT PRIMARY KEY,
        function_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        input_args TEXT,
        input_kwargs TEXT,
        output_result TEXT,
        error TEXT,
        execution_time_ms REAL NOT NULL,
        timestamp TEXT NOT NULL,
        parent_log_id TEXT
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS secret_keys (
        key_name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS vector_memory (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  // --- Function Management ---

  public saveFunction(func: Omit<FunctionMetadata, "created_at" | "updated_at" | "version"> & { version?: number }): FunctionMetadata {
    const now = new Date().toISOString();
    const existing = this.getFunction(func.name);

    const version = func.version ?? (existing ? existing.version + 1 : 1);
    const importsStr = JSON.stringify(func.imports || []);
    const depsStr = JSON.stringify(func.dependencies || []);
    const keyDepsStr = JSON.stringify(func.key_dependencies || []);
    const metaStr = JSON.stringify(func.metadata || {});
    const desc = func.description || func.metadata?.description || "";
    const isActive = func.is_active !== undefined ? (func.is_active ? 1 : 0) : 1;

    if (existing) {
      this.db.run(
        `UPDATE functions
         SET code = ?, description = ?, imports = ?, dependencies = ?, key_dependencies = ?, version = ?, metadata = ?, updated_at = ?, is_active = ?
         WHERE name = ?`,
        [func.code, desc, importsStr, depsStr, keyDepsStr, version, metaStr, now, isActive, func.name]
      );
    } else {
      this.db.run(
        `INSERT INTO functions (name, code, description, imports, dependencies, key_dependencies, version, metadata, created_at, updated_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [func.name, func.code, desc, importsStr, depsStr, keyDepsStr, version, metaStr, now, now, isActive]
      );
    }

    // Save version history
    this.db.run(
      `INSERT INTO function_versions (function_name, version, code, imports, dependencies, key_dependencies, metadata, created_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [func.name, version, func.code, importsStr, depsStr, keyDepsStr, metaStr, now, isActive]
    );

    return this.getFunction(func.name)!;
  }

  public getFunction(name: string): FunctionMetadata | null {
    const row = this.db.query(`SELECT * FROM functions WHERE name = ?`).get(name) as any;
    if (!row) return null;
    return this.parseFunctionRow(row);
  }

  public getAllFunctions(): FunctionMetadata[] {
    const rows = this.db.query(`SELECT * FROM functions ORDER BY name ASC`).all() as any[];
    return rows.map((r) => this.parseFunctionRow(r));
  }

  public deleteFunction(name: string): boolean {
    this.db.run(`DELETE FROM function_versions WHERE function_name = ?`, [name]);
    const res = this.db.run(`DELETE FROM functions WHERE name = ?`, [name]);
    return res.changes > 0;
  }

  public getFunctionVersions(name: string): FunctionVersion[] {
    const rows = this.db.query(`SELECT * FROM function_versions WHERE function_name = ? ORDER BY version DESC`).all(name) as any[];
    return rows.map((r) => ({
      id: r.id,
      function_name: r.function_name,
      version: r.version,
      code: r.code,
      imports: JSON.parse(r.imports || "[]"),
      dependencies: JSON.parse(r.dependencies || "[]"),
      key_dependencies: JSON.parse(r.key_dependencies || "[]"),
      metadata: JSON.parse(r.metadata || "{}"),
      created_at: r.created_at,
      is_active: Boolean(r.is_active)
    }));
  }

  public activateFunctionVersion(name: string, version: number): boolean {
    const versionRow = this.db.query(`SELECT * FROM function_versions WHERE function_name = ? AND version = ?`).get(name, version) as any;
    if (!versionRow) return false;

    const now = new Date().toISOString();
    this.db.run(
      `UPDATE functions
       SET code = ?, imports = ?, dependencies = ?, key_dependencies = ?, version = ?, metadata = ?, updated_at = ?, is_active = 1
       WHERE name = ?`,
      [versionRow.code, versionRow.imports, versionRow.dependencies, versionRow.key_dependencies, versionRow.version, versionRow.metadata, now, name]
    );
    return true;
  }

  private parseFunctionRow(row: any): FunctionMetadata {
    return {
      name: row.name,
      code: row.code,
      description: row.description || "",
      imports: JSON.parse(row.imports || "[]"),
      dependencies: JSON.parse(row.dependencies || "[]"),
      key_dependencies: JSON.parse(row.key_dependencies || "[]"),
      version: row.version,
      metadata: JSON.parse(row.metadata || "{}"),
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_active: Boolean(row.is_active)
    };
  }

  // --- Execution Logs ---

  public logExecution(log: ExecutionLog): void {
    this.db.run(
      `INSERT INTO execution_logs (log_id, function_name, version, input_args, input_kwargs, output_result, error, execution_time_ms, timestamp, parent_log_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.log_id,
        log.function_name,
        log.version,
        JSON.stringify(log.input_args ?? []),
        JSON.stringify(log.input_kwargs ?? {}),
        JSON.stringify(log.output_result ?? null),
        log.error,
        log.execution_time_ms,
        log.timestamp,
        log.parent_log_id
      ]
    );
  }

  public getLogs(filter?: { function_name?: string; limit?: number; offset?: number }): ExecutionLog[] {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    let rows: any[];

    if (filter?.function_name) {
      rows = this.db.query(
        `SELECT * FROM execution_logs WHERE function_name = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      ).all(filter.function_name, limit, offset) as any[];
    } else {
      rows = this.db.query(
        `SELECT * FROM execution_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      ).all(limit, offset) as any[];
    }

    return rows.map((r) => this.parseLogRow(r));
  }

  public getLog(logId: string): ExecutionLog | null {
    const row = this.db.query(`SELECT * FROM execution_logs WHERE log_id = ?`).get(logId) as any;
    if (!row) return null;
    return this.parseLogRow(row);
  }

  public getLogTree(rootLogId: string): ExecutionLog[] {
    const rows = this.db.query(
      `WITH RECURSIVE trace AS (
         SELECT * FROM execution_logs WHERE log_id = ?
         UNION ALL
         SELECT el.* FROM execution_logs el
         JOIN trace t ON el.parent_log_id = t.log_id
       )
       SELECT * FROM trace ORDER BY timestamp ASC`
    ).all(rootLogId) as any[];

    return rows.map((r) => this.parseLogRow(r));
  }

  public getLogCount(): number {
    const res = this.db.query(`SELECT COUNT(*) as cnt FROM execution_logs`).get() as any;
    return res?.cnt ?? 0;
  }

  private parseLogRow(row: any): ExecutionLog {
    let parsedOutput = null;
    try {
      parsedOutput = row.output_result ? JSON.parse(row.output_result) : null;
    } catch {
      parsedOutput = row.output_result;
    }

    return {
      log_id: row.log_id,
      function_name: row.function_name,
      version: row.version,
      input_args: JSON.parse(row.input_args || "[]"),
      input_kwargs: JSON.parse(row.input_kwargs || "{}"),
      output_result: parsedOutput,
      error: row.error,
      execution_time_ms: row.execution_time_ms,
      timestamp: row.timestamp,
      parent_log_id: row.parent_log_id
    };
  }

  // --- Secret Keys Store ---

  public setKey(keyName: string, value: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO secret_keys (key_name, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key_name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [keyName, value, now]
    );
  }

  public getKey(keyName: string): string | null {
    const row = this.db.query(`SELECT value FROM secret_keys WHERE key_name = ?`).get(keyName) as any;
    if (row && row.value) return row.value;
    // Fall back to process.env
    return process.env[keyName] || process.env[keyName.toUpperCase()] || null;
  }

  public getAllKeys(): { key_name: string; updated_at: string; is_set: boolean }[] {
    const rows = this.db.query(`SELECT key_name, updated_at FROM secret_keys`).all() as any[];
    return rows.map((r) => ({
      key_name: r.key_name,
      updated_at: r.updated_at,
      is_set: true
    }));
  }

  public deleteKey(keyName: string): boolean {
    const res = this.db.run(`DELETE FROM secret_keys WHERE key_name = ?`, [keyName]);
    return res.changes > 0;
  }

  // --- Vector Memory Store ---

  public saveVector(id: string, text: string, embedding: number[], metadata: Record<string, any> = {}): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO vector_memory (id, text, embedding, metadata, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, embedding = excluded.embedding, metadata = excluded.metadata`,
      [id, text, JSON.stringify(embedding), JSON.stringify(metadata), now]
    );
  }

  public getAllVectors(): VectorDocument[] {
    const rows = this.db.query(`SELECT * FROM vector_memory`).all() as any[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      embedding: JSON.parse(r.embedding || "[]"),
      metadata: JSON.parse(r.metadata || "{}"),
      created_at: r.created_at
    }));
  }

  public clearVectors(): void {
    this.db.run(`DELETE FROM vector_memory`);
  }

  public close(): void {
    this.db.close();
  }
}
