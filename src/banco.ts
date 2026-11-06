import { DatabaseSync } from "node:sqlite";

export function abrirBanco(caminho = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(caminho);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, nome TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profissionais (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), nome TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      email TEXT NOT NULL, senha TEXT NOT NULL, nome TEXT NOT NULL,
      papel TEXT NOT NULL CHECK (papel IN ('dono', 'atendente', 'profissional')),
      profissional_id INTEGER REFERENCES profissionais(id),
      UNIQUE (tenant_id, email)
    );
    CREATE TABLE IF NOT EXISTS servicos (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      nome TEXT NOT NULL, minutos INTEGER NOT NULL CHECK (minutos > 0), preco REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expedientes (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, profissional_id INTEGER NOT NULL REFERENCES profissionais(id),
      dia_semana INTEGER NOT NULL, inicio TEXT NOT NULL, fim TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bloqueios (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, profissional_id INTEGER NOT NULL REFERENCES profissionais(id),
      inicio TEXT NOT NULL, fim TEXT NOT NULL, motivo TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reservas (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      profissional_id INTEGER NOT NULL REFERENCES profissionais(id), servico_id INTEGER NOT NULL REFERENCES servicos(id),
      cliente TEXT NOT NULL, inicio TEXT NOT NULL, fim TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmada' CHECK (status IN ('confirmada', 'cancelada', 'faltou')),
      chave TEXT, origem TEXT NOT NULL DEFAULT 'balcao',
      UNIQUE (tenant_id, chave)
    );
    CREATE INDEX IF NOT EXISTS idx_reservas_agenda ON reservas (tenant_id, profissional_id, inicio);
    CREATE TABLE IF NOT EXISTS espera (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, profissional_id INTEGER NOT NULL REFERENCES profissionais(id),
      servico_id INTEGER NOT NULL REFERENCES servicos(id), cliente TEXT NOT NULL, dia TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aguardando', reserva_id INTEGER REFERENCES reservas(id)
    );
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, ator TEXT NOT NULL, acao TEXT NOT NULL, detalhe TEXT NOT NULL
    );
  `);
  return db;
}
