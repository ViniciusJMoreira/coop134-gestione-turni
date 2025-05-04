// backend/index.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
const PORT = 5000;

// ID del Google Sheet (ricavabile dall’URL del foglio tra "/d/" e "/edit")
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SHEET_EMPLOYEE = process.env.SHEET_EMPLOYEE;;
const RANGE_EMPLOYEE = `${SHEET_EMPLOYEE}!A:B`; // intervallo usato (colonne A-D)

// Caricamento credenziali del Service Account
const credentials = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
};

// Inizializza il client di autenticazione Google
const auth = new google.auth.GoogleAuth({
  credentials: credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"], // scope per accesso in lettura/scrittura Sheets
});

// Middleware Express
app.use(cors()); // abilita CORS per accettare richieste dal frontend
app.use(express.json()); // parsing JSON del body delle richieste

// Funzione helper per ottenere un (filtrate per ID)
async function getUserById(userId) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  // Legge tutti i valori nell’intervallo specificato (tutte le colonne A-D)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE_EMPLOYEE,
  });
  const rows = res.data.values;
  if (!rows || rows.length === 0) {
    return []; // foglio vuoto o nessun dato
  }
  // Si assume che la prima riga sia intestazione: [ID, Data, Attività, Note]
  const usersRows = rows.slice(1); // esclude l'intestazione
  // Mappa le righe nei nostri oggetti attività e filtra per ID corrispondente
  const userRow = usersRows.find(row => row[1] === userId);
  return userRow;
}

// Funzione helper per ottenere tutte le attività di un dato utente (filtrate per ID)
async function getRecordsById(userId) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: client });
  const RANGE_NAME = `Tabella-${userId}!A:I`;
  // Legge tutti i valori nell’intervallo specificato (tutte le colonne A-D)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE_NAME,
  });
  const rows = res.data.values;

  if (!rows || rows.length === 0) return []; // foglio vuoto o nessun dato

  // Si assume che la prima riga sia intestazione: [ID, Data, Attività, Note]
  const dataRows = rows.slice(1); // esclude l'intestazione
  // Mappa le righe nei nostri oggetti attività e filtra per ID corrispondente
  const data = dataRows
    .map((row, index) => {
      // Destruttura assicurandosi di avere 4 colonne (valori mancanti -> stringa vuota)
      const [date, worksite, task, startTime, endTime, totalHours, km, notes] =
        [
          row[0] || "",
          row[1] || "",
          row[2] || "",
          row[3] || "",
          row[4] || "",
          row[5] || "",
          row[6] || "",
          row[7] || "",
        ];
      return {
        date,
        worksite,
        task,
        startTime,
        endTime,
        totalHours,
        km,
        notes,
        rowNumber: index + 2, // calcola il numero di riga effettivo (indice 0 -> riga 2)
      };
    }).filter(row => row.date !== "");
  return data;
}

// Route: Login operatore (verifica ID e restituisce dati utente)
app.post("/api/login", async (req, res) => {
  try {
    const userId = req.body.id;
    const employee = await getUserById(userId);
    if(!employee || employee.length === 0) throw new Error("ID inesistente");
    const [name, id] = employee;
    const records = await getRecordsById(userId);
    // Consente login anche se non ci sono ancora record (utente nuovo) -> restituisce array vuoto
    return res.json({ employee: { name, id }, records });
  } catch (error) {
    console.error("Errore in /api/login:", error);
    res.status(500).json({ message: error.message });
  }
});

// Route: Aggiungere una nuova attività
app.post("/api/activities", async (req, res) => {
  try {
    const { id, date, worksite, task, startTime, endTime, totalHours, km, notes } = req.body;
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    const RANGE_NAME = `Tabella-${id}!A:I`;
    // Aggiungi una nuova riga al foglio con i valori forniti
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_NAME,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: {
        values: [
          [date, worksite, task, startTime, endTime, totalHours, km, notes],
        ],
      },
    });
    // Ricarica le attività aggiornate dell'utente e restituiscile
    const records = await getRecordsById(id);
    return res.status(201).json({ message: "Attività aggiunta con successo", records: records });
  } catch (error) {
    console.error("Errore in POST /api/activities:", error);
    res.status(500).json({ message: "Errore del server durante l'aggiunta" });
  }
});

// Route: Modificare un'attività esistente (identificata dal numero di riga)
app.put("/api/activities/:row", async (req, res) => {
  try {
    const rowNumber = req.params.row; // numero di riga da aggiornare
    const { id, date, worksite, task, startTime, endTime, totalHours, km, notes } = req.body;
    const client = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: client });
    // Aggiorna la riga specificata con i nuovi valori
    const range = `Tabella-${id}!A${rowNumber}:I${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
      valueInputOption: "RAW",
      resource: {
        values: [
          [date, worksite, task, startTime, endTime, totalHours, km, notes],
        ],
      },
    });
    // Recupera elenco aggiornato e invialo come risposta
    const records = await getRecordsById(id);
    return res.json({ message: "Attività aggiornata con successo", records: records });
  } catch (error) {
    console.error("Errore in PUT /api/activities:", error);
    res
      .status(500)
      .json({ message: "Errore del server durante l'aggiornamento" });
  }
});

// Avvia il server
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});