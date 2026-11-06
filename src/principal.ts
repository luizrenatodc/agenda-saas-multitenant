import { abrirBanco } from "./banco.ts";
import { criarApp } from "./app.ts";
import { semear } from "./semente.ts";

const db = abrirBanco(process.env.BANCO ?? "agenda.db");
semear(db);
const porta = Number(process.env.PORTA ?? 3000);
criarApp(db, process.env.SEGREDO ?? "troque-em-producao").listen(porta, () => console.log(`Painel em http://localhost:${porta}`));
