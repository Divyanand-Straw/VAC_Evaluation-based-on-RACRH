/**
 * Local Results Storage & CSV Export Engine
 * Handles caching completed evaluation runs into LocalStorage and formatting CSV reports
 */

const STORAGE_KEY = "ai_clinic_evaluation_results";

export function loadSavedEvaluation() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("Failed to load saved evaluation from LocalStorage:", e);
    return null;
  }
}

export function saveEvaluationResults(evaluationPayload) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(evaluationPayload));
  } catch (e) {
    console.error("Failed to save evaluation results to LocalStorage:", e);
  }
}

export function generateCSVReport({ modelA, modelB, questionResults }) {
  const headers = [
    "Question ID",
    "Question",
    "Test Type",
    "Expected Answer",
    "Expected FAQ ID",
    "Retrieved FAQ ID",
    "Similarity Score",
    "Retrieval Correct",
    `[${modelA.name}] Answer`,
    `[${modelA.name}] Correctness`,
    `[${modelA.name}] Relevance`,
    `[${modelA.name}] Hallucination`,
    `[${modelB.name}] Answer`,
    `[${modelB.name}] Correctness`,
    `[${modelB.name}] Relevance`,
    `[${modelB.name}] Hallucination`
  ];

  const rows = questionResults.map(item => {
    const q = item.question;
    const resA = item.modelA;
    const resB = item.modelB;

    const escapeCsv = (str) => {
      if (str === null || str === undefined) return '""';
      const clean = String(str).replace(/"/g, '""');
      return `"${clean}"`;
    };

    return [
      escapeCsv(q.id),
      escapeCsv(q.question),
      escapeCsv(q.test_type),
      escapeCsv(q.expected_answer),
      escapeCsv(q.expected_faq_id),
      escapeCsv(item.retrievedFaq.id),
      escapeCsv(item.similarityScore),
      escapeCsv(resA.retrievalCorrect ? "YES" : "NO"),

      escapeCsv(resA.generatedAnswer),
      escapeCsv(resA.answerCorrect ? "Correct" : "Incorrect"),
      escapeCsv(resA.answerRelevance ? "Relevant" : "Not Relevant"),
      escapeCsv(resA.hallucinationDetected ? "YES" : "NO"),

      escapeCsv(resB.generatedAnswer),
      escapeCsv(resB.answerCorrect ? "Correct" : "Incorrect"),
      escapeCsv(resB.answerRelevance ? "Relevant" : "Not Relevant"),
      escapeCsv(resB.hallucinationDetected ? "YES" : "NO")
    ].join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

export function downloadCSV(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
