/**
 * Evaluation Engine for the Four Core Metrics:
 * 1. Retrieval Accuracy (retrieved FAQ ID == expected FAQ ID)
 * 2. Answer Correctness (Factual agreement with expected answer & context)
 * 3. Answer Relevance (Directness in addressing query intent)
 * 4. Hallucination Rate (Detection of unsupported claims outside context)
 */

function cleanText(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();
}

/**
 * Evaluate single question result for a given model
 */
export function evaluateResult({
  testQuestion,
  retrievedFaq,
  similarityScore,
  generatedAnswer,
  modelId
}) {
  const expectedFaqId = testQuestion.expected_faq_id;
  const retrievedFaqId = retrievedFaq.id;
  
  // 1. Metric 1: Retrieval Accuracy
  const retrievalCorrect = retrievedFaqId === expectedFaqId;

  const cleanGenerated = cleanText(generatedAnswer);
  const cleanExpected = cleanText(testQuestion.expected_answer);
  const cleanContext = cleanText(retrievedFaq.context);

  const isOutOfScope = testQuestion.test_type === "Out-of-Scope" || testQuestion.test_type === "Hallucination Test";
  const standardRefusalText = "information not available in the provided clinic knowledge base";

  // 2. Metric 4: Hallucination Rate Detection
  let hallucinationDetected = false;
  
  if (isOutOfScope) {
    // For out-of-scope, if model does NOT refuse and gives fabricated clinic details -> Hallucination!
    if (!cleanGenerated.includes(standardRefusalText) && !cleanGenerated.includes("not available")) {
      hallucinationDetected = true;
    }
  } else {
    // Check if generated answer asserts facts absent from context
    // E.g., mentioning "general anesthesia" or "free dental" when not in context
    const externalClaims = ["anesthesia", "overnight", "free dental", "unlimited", "surgery"];
    externalClaims.forEach(claim => {
      if (cleanGenerated.includes(claim) && !cleanContext.includes(claim)) {
        hallucinationDetected = true;
      }
    });
  }

  // 3. Metric 2: Answer Correctness
  let answerCorrect = false;

  if (isOutOfScope) {
    // Out-of-scope questions are correct IF and ONLY IF refusal is given AND no hallucination occurs
    answerCorrect = !hallucinationDetected && cleanGenerated.includes("not available");
  } else {
    // Calculate keyword & semantic overlap between generated answer and expected answer/context
    const expectedKeywords = cleanExpected.split(/\s+/).filter(w => w.length > 3);
    const matchedCount = expectedKeywords.filter(k => cleanGenerated.includes(k)).length;
    const matchRatio = expectedKeywords.length > 0 ? (matchedCount / expectedKeywords.length) : 0;

    // Must have good overlap and NO hallucination
    answerCorrect = (matchRatio >= 0.35 || cleanGenerated.includes(cleanExpected)) && !hallucinationDetected;
  }

  // 4. Metric 3: Answer Relevance
  let answerRelevance = false;
  
  if (isOutOfScope) {
    // Refusal for out-of-scope is considered relevant
    answerRelevance = true;
  } else {
    // Check if query subject keywords are reflected in the answer
    const queryKeywords = cleanText(testQuestion.question).split(/\s+/).filter(w => w.length > 3);
    const queryMatchCount = queryKeywords.filter(k => cleanGenerated.includes(k) || cleanContext.includes(k)).length;
    answerRelevance = queryMatchCount >= 1 && generatedAnswer.length >= 10;
  }

  return {
    retrievalCorrect,
    answerCorrect,
    answerRelevance,
    hallucinationDetected,
    metricsSummary: {
      retrievalStatus: retrievalCorrect ? "Correct" : "Incorrect",
      correctnessStatus: answerCorrect ? "Correct" : "Incorrect",
      relevanceStatus: answerRelevance ? "Relevant" : "Not Relevant",
      hallucinationStatus: hallucinationDetected ? "Hallucination Detected" : "No Hallucination"
    }
  };
}

/**
 * Aggregate model evaluation statistics across all benchmark test results
 */
export function aggregateMetrics(results) {
  if (!results || results.length === 0) {
    return {
      totalQuestions: 0,
      retrievalAccuracy: 0,
      answerCorrectness: 0,
      answerRelevance: 0,
      hallucinationRate: 0,
      retrievalCount: "0/0",
      correctnessCount: "0/0",
      relevanceCount: "0/0",
      hallucinationCount: "0/0"
    };
  }

  const N = results.length;
  const correctRetrievals = results.filter(r => r.retrievalCorrect).length;
  const correctAnswers = results.filter(r => r.answerCorrect).length;
  const relevantAnswers = results.filter(r => r.answerRelevance).length;
  const hallucinations = results.filter(r => r.hallucinationDetected).length;

  const retrievalAccuracy = Math.round((correctRetrievals / N) * 100);
  const answerCorrectness = Math.round((correctAnswers / N) * 100);
  const answerRelevance = Math.round((relevantAnswers / N) * 100);
  const hallucinationRate = Math.round((hallucinations / N) * 100);

  return {
    totalQuestions: N,
    retrievalAccuracy,
    answerCorrectness,
    answerRelevance,
    hallucinationRate,
    retrievalCount: `${correctRetrievals}/${N}`,
    correctnessCount: `${correctAnswers}/${N}`,
    relevanceCount: `${relevantAnswers}/${N}`,
    hallucinationCount: `${hallucinations}/${N}`
  };
}
