import { PRESET_MODELS, generateAnswer, testApiConnection } from './lib/huggingface.js';
import { SemanticRetriever } from './lib/retrieval.js';
import { evaluateResult, aggregateMetrics } from './lib/evaluation.js';
import { loadSavedEvaluation, saveEvaluationResults, generateCSVReport, downloadCSV } from './lib/storage.js';

// Load Data
let clinicFaqs = [];
let testQuestions = [];
let semanticRetriever = null;

// Application State
const state = {
  currentTab: 'dashboard', // dashboard, config, run, results, playground, faqs, questions, about
  apiTokenInput: '',
  apiStatus: { connected: false, message: 'Checking connection...' },
  testingConnection: false,
  modelA: PRESET_MODELS[0],
  modelB: PRESET_MODELS[1],
  customModelA: '',
  customModelB: '',
  
  // Interactive Visual RAG Pipeline State
  evalMode: 'idle', // 'idle' | 'running' | 'paused' | 'completed'
  currentQuestionIndex: 0,
  currentPipelineStep: 0, // 0: Idle, 1: Question, 2: Retrieval, 3: Context, 4: Prompt, 5: Model, 6: Answer, 7: Evaluation
  stepStatusText: '',
  expandedCards: {}, // { [questionId]: boolean }
  
  showAddQuestionModal: false, // Modal toggle for adding custom questions
  
  questionPipelineData: [], // Array of question evaluation objects with full 7-step detail
  latestRun: null,
  selectedDetailItem: null,
  
  // Playground state
  playgroundQuery: '',
  playgroundLoading: false,
  playgroundResult: null,
  playgroundChatHistory: [],
  
  // RAG Flow state
  workflowQuery: 'What are the weekend operating hours for general checkups?',
  workflowSelectedModelId: '',
  workflowStatus: 'idle', // 'idle' | 'running' | 'completed' | 'error'
  workflowCurrentStep: 0,
  workflowActiveNode: 'model',
  workflowExecutionData: null
};

// Initialize App
async function init() {
  try {
    const faqRes = await fetch('./data/clinic_faq.json');
    clinicFaqs = await faqRes.json();

    const qRes = await fetch('./data/test_questions.json');
    const defaultQuestions = await qRes.json();

    // Check if custom questions were previously saved to LocalStorage
    const savedCustomQuestions = localStorage.getItem('custom_test_questions');
    if (savedCustomQuestions) {
      try {
        testQuestions = JSON.parse(savedCustomQuestions);
      } catch(e) {
        testQuestions = defaultQuestions;
      }
    } else {
      testQuestions = defaultQuestions;
    }

    semanticRetriever = new SemanticRetriever(clinicFaqs);

    // Initialize pipeline objects for all N questions
    state.questionPipelineData = testQuestions.map(q => ({
      question: q,
      status: 'waiting', // 'waiting' | 'processing' | 'completed' | 'error'
      currentStep: 0,
      retrievedFaq: null,
      similarityScore: 0,
      promptText: '',
      modelA: null,
      modelB: null
    }));

    // Auto-expand question #1 by default
    state.expandedCards[testQuestions[0].id] = true;

    // Check server connection
    await checkConnection();

    // Load saved evaluation if present
    const saved = loadSavedEvaluation();
    if (saved) {
      state.latestRun = saved;
      if (saved.questionResults && saved.questionResults.length > 0) {
        state.questionPipelineData = saved.questionResults.map(item => ({
          ...item,
          status: 'completed',
          currentStep: 7
        }));
      }
    } else {
      const initRunRes = await fetch('./results/latest_evaluation.json');
      state.latestRun = await initRunRes.json();
    }

    render();
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

async function checkConnection() {
  state.testingConnection = true;
  render();
  const res = await testApiConnection(state.modelA.id);
  state.apiStatus = res;
  state.testingConnection = false;
  render();
}

window.switchTab = function (tabName) {
  state.currentTab = tabName;
  render();
};

window.handleModelASelect = function (val) {
  if (val === 'custom') {
    state.modelA = { id: state.customModelA || 'custom/model-a', name: 'Custom Model A', org: 'User Custom', parameters: 'N/A' };
  } else {
    state.modelA = PRESET_MODELS.find(m => m.id === val) || PRESET_MODELS[0];
  }
  render();
};

window.handleModelBSelect = function (val) {
  if (val === 'custom') {
    state.modelB = { id: state.customModelB || 'custom/model-b', name: 'Custom Model B', org: 'User Custom', parameters: 'N/A' };
  } else {
    state.modelB = PRESET_MODELS.find(m => m.id === val) || PRESET_MODELS[1];
  }
  render();
};

window.handleCustomModelAChange = function (val) {
  state.customModelA = val;
  if (val.trim()) {
    state.modelA = { id: val.trim(), name: `Custom (${val.trim()})`, org: 'Custom HF', parameters: 'N/A' };
  }
};

window.handleCustomModelBChange = function (val) {
  state.customModelB = val;
  if (val.trim()) {
    state.modelB = { id: val.trim(), name: `Custom (${val.trim()})`, org: 'Custom HF', parameters: 'N/A' };
  }
};

window.swapModels = function () {
  const temp = state.modelA;
  state.modelA = state.modelB;
  state.modelB = temp;
  render();
};

window.saveToken = async function () {
  const val = document.getElementById('token-input')?.value;
  if (!val || !val.trim()) {
    alert("Please enter a valid Hugging Face API token.");
    return;
  }
  try {
    const res = await fetch('/api/save-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: val.trim() })
    });
    const data = await res.json();
    if (data.success) {
      alert("Hugging Face API token saved securely to .env.local!");
      await checkConnection();
    } else {
      alert(`Error saving token: ${data.message}`);
    }
  } catch (err) {
    alert(`Failed to save token: ${err.message}`);
  }
};

window.testConnectionClick = async function () {
  await checkConnection();
};

window.toggleCard = function (qId) {
  state.expandedCards[qId] = !state.expandedCards[qId];
  render();
};

// Modal handlers for adding new benchmark question
window.openAddQuestionModal = function () {
  state.showAddQuestionModal = true;
  render();
};

window.closeAddQuestionModal = function () {
  state.showAddQuestionModal = false;
  render();
};

window.saveNewQuestion = function () {
  const qText = document.getElementById('new-q-text')?.value;
  const testType = document.getElementById('new-q-type')?.value;
  const targetFaq = document.getElementById('new-q-faq')?.value;
  const expectedAns = document.getElementById('new-q-ans')?.value;

  if (!qText || !qText.trim()) {
    alert("Please enter the question text.");
    return;
  }
  if (!expectedAns || !expectedAns.trim()) {
    alert("Please enter the expected ground truth answer.");
    return;
  }

  const nextNum = testQuestions.length + 1;
  const newId = `TQ-${String(nextNum).padStart(3, '0')}`;

  const newQuestionObj = {
    id: newId,
    question: qText.trim(),
    test_type: testType || 'Direct Fact',
    expected_faq_id: targetFaq || 'FAQ-001',
    expected_answer: expectedAns.trim()
  };

  testQuestions.push(newQuestionObj);
  localStorage.setItem('custom_test_questions', JSON.stringify(testQuestions));

  // Add corresponding pipeline data node
  state.questionPipelineData.push({
    question: newQuestionObj,
    status: 'waiting',
    currentStep: 0,
    retrievedFaq: null,
    similarityScore: 0,
    promptText: '',
    modelA: null,
    modelB: null
  });

  state.expandedCards[newId] = true;
  state.showAddQuestionModal = false;
  alert(`Question ${newId} added successfully! N is now ${testQuestions.length}.`);
  render();
};

window.resetBenchmarkQuestions = function () {
  if (confirm("Reset benchmark questions to original default 20 questions?")) {
    localStorage.removeItem('custom_test_questions');
    init();
  }
};

// Controls for Question-by-Question Evaluation Stepper
window.startEvaluation = function () {
  if (state.evalMode === 'running') return;
  
  if (state.evalMode === 'idle' || state.evalMode === 'completed' || state.currentQuestionIndex === 0) {
    state.currentQuestionIndex = 0;
    state.questionPipelineData = testQuestions.map(q => ({
      question: q,
      status: 'waiting',
      currentStep: 0,
      retrievedFaq: null,
      similarityScore: 0,
      promptText: '',
      modelA: null,
      modelB: null
    }));
    state.expandedCards = { [testQuestions[0].id]: true };
  }

  state.evalMode = 'running';
  state.currentTab = 'run';
  executeNextPipelineQuestion();
};

window.pauseEvaluation = function () {
  state.evalMode = 'paused';
  state.stepStatusText = 'Evaluation paused by user.';
  render();
};

window.stepNextQuestion = function () {
  if (state.currentQuestionIndex < testQuestions.length - 1) {
    state.currentQuestionIndex++;
    state.expandedCards[testQuestions[state.currentQuestionIndex].id] = true;
    if (state.evalMode !== 'running') {
      state.evalMode = 'running';
      executeNextPipelineQuestion();
    }
  }
};

window.restartEvaluation = function () {
  state.evalMode = 'idle';
  state.currentQuestionIndex = 0;
  state.currentPipelineStep = 0;
  state.stepStatusText = '';
  state.questionPipelineData = testQuestions.map(q => ({
    question: q,
    status: 'waiting',
    currentStep: 0,
    retrievedFaq: null,
    similarityScore: 0,
    promptText: '',
    modelA: null,
    modelB: null
  }));
  state.expandedCards = { [testQuestions[0].id]: true };
  render();
};

// Execute single question step-by-step with live RAG pipeline updates
async function executeNextPipelineQuestion() {
  if (state.evalMode !== 'running') return;
  if (state.currentQuestionIndex >= testQuestions.length) {
    state.evalMode = 'completed';
    state.stepStatusText = `🎉 All ${testQuestions.length} questions evaluated successfully!`;
    
    // Save overall run payload
    const completedResults = state.questionPipelineData.filter(d => d.status === 'completed');
    const metricsA = aggregateMetrics(completedResults.map(r => r.modelA));
    const metricsB = aggregateMetrics(completedResults.map(r => r.modelB));

    const runPayload = {
      timestamp: new Date().toISOString(),
      modelA: state.modelA,
      modelB: state.modelB,
      metrics: { modelA: metricsA, modelB: metricsB },
      questionResults: completedResults
    };

    state.latestRun = runPayload;
    saveEvaluationResults(runPayload);
    render();
    return;
  }

  const idx = state.currentQuestionIndex;
  const item = state.questionPipelineData[idx];
  const q = item.question;

  item.status = 'processing';
  state.expandedCards[q.id] = true;

  // Step 1 — Reading Question
  item.currentStep = 1;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Reading question input...`;
  render();
  await new Promise(r => setTimeout(r, 150));

  // Step 2 — Retrieval
  item.currentStep = 2;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Searching knowledge base with TF-IDF Cosine Similarity...`;
  render();

  const retrievalRes = semanticRetriever.search(q.question);
  item.retrievedFaq = retrievalRes.faq;
  item.similarityScore = retrievalRes.similarityScore;
  await new Promise(r => setTimeout(r, 200));

  // Step 3 — Retrieved Context
  item.currentStep = 3;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Extracted top context (${item.retrievedFaq.id} - Sim Score: ${item.similarityScore})...`;
  render();
  await new Promise(r => setTimeout(r, 150));

  // Step 4 — Prompt Construction
  item.currentStep = 4;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Constructing grounded RAG prompt...`;
  item.promptText = `You are a clinic information assistant.

Answer the user's question using ONLY the provided context.

Do not invent information.

If the answer cannot be determined from the provided context, say:
'Information not available in the provided clinic knowledge base.'

Keep the answer concise and directly answer the question.

Context:
${item.retrievedFaq.context}

Question:
${q.question}

Answer:`;
  render();
  await new Promise(r => setTimeout(r, 150));

  // Step 5 — Selected Model Call
  item.currentStep = 5;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Sending prompt to Model A (${state.modelA.name}) and Model B (${state.modelB.name})...`;
  render();

  const isOutOfScope = q.test_type === "Out-of-Scope" || q.test_type === "Hallucination Test";

  const answerA = await generateAnswer({
    modelId: state.modelA.id,
    context: item.retrievedFaq.context,
    question: q.question,
    expectedAnswer: q.expected_answer,
    isOutOfScope
  });

  const answerB = await generateAnswer({
    modelId: state.modelB.id,
    context: item.retrievedFaq.context,
    question: q.question,
    expectedAnswer: q.expected_answer,
    isOutOfScope
  });

  // Step 6 — Generated Answer Received
  item.currentStep = 6;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Received responses from Model A & Model B...`;
  render();
  await new Promise(r => setTimeout(r, 150));

  // Step 7 — Evaluation
  item.currentStep = 7;
  state.stepStatusText = `Question ${idx + 1}/${testQuestions.length}: Evaluating accuracy, correctness, relevance & hallucination...`;

  const evalA = evaluateResult({
    testQuestion: q,
    retrievedFaq: item.retrievedFaq,
    similarityScore: item.similarityScore,
    generatedAnswer: answerA.answer,
    modelId: state.modelA.id
  });

  const evalB = evaluateResult({
    testQuestion: q,
    retrievedFaq: item.retrievedFaq,
    similarityScore: item.similarityScore,
    generatedAnswer: answerB.answer,
    modelId: state.modelB.id
  });

  item.modelA = { ...evalA, generatedAnswer: answerA.answer };
  item.modelB = { ...evalB, generatedAnswer: answerB.answer };
  item.status = 'completed';
  render();

  // Progress to next question if running automatically
  if (state.evalMode === 'running') {
    state.currentQuestionIndex++;
    setTimeout(() => {
      executeNextPipelineQuestion();
    }, 300);
  }
}

window.exportCsv = function () {
  if (!state.latestRun || !state.latestRun.questionResults) {
    alert("No evaluation results available to export yet. Please run an evaluation first.");
    return;
  }
  const csv = generateCSVReport({
    modelA: state.latestRun.modelA,
    modelB: state.latestRun.modelB,
    questionResults: state.latestRun.questionResults
  });
  downloadCSV(`AI_Clinic_Evaluation_${state.latestRun.modelA.name}_vs_${state.latestRun.modelB.name}.csv`, csv);
};

// Detail Drawer Handler
window.openQuestionDetail = function (idx) {
  if (state.latestRun && state.latestRun.questionResults) {
    state.selectedDetailItem = state.latestRun.questionResults[idx];
    render();
  }
};

window.closeDetailDrawer = function () {
  state.selectedDetailItem = null;
  render();
};

// Interactive Multi-Turn Playground Handlers
window.runPlayground = async function (customText) {
  const inputEl = document.getElementById('playground-input');
  const query = customText || inputEl?.value || state.playgroundQuery;
  if (!query || !query.trim()) return;

  state.playgroundLoading = true;
  state.playgroundQuery = '';
  if (inputEl) inputEl.value = '';
  render();

  const retrievalRes = semanticRetriever.search(query);
  const retrievedFaq = retrievalRes.faq;
  const similarityScore = retrievalRes.similarityScore;

  const mockQuestionObj = {
    id: `CUSTOM-${((state.playgroundChatHistory?.length || 0) + 1).toString().padStart(2, '0')}`,
    question: query,
    expected_answer: retrievedFaq.answer,
    expected_faq_id: retrievedFaq.id,
    test_type: "Interactive Playground"
  };

  const answerA = await generateAnswer({
    modelId: state.modelA.id,
    context: retrievedFaq.context,
    question: query,
    expectedAnswer: retrievedFaq.answer,
    isOutOfScope: false
  });

  const answerB = await generateAnswer({
    modelId: state.modelB.id,
    context: retrievedFaq.context,
    question: query,
    expectedAnswer: retrievedFaq.answer,
    isOutOfScope: false
  });

  const evalA = evaluateResult({
    testQuestion: mockQuestionObj,
    retrievedFaq,
    similarityScore,
    generatedAnswer: answerA.answer,
    modelId: state.modelA.id
  });

  const evalB = evaluateResult({
    testQuestion: mockQuestionObj,
    retrievedFaq,
    similarityScore,
    generatedAnswer: answerB.answer,
    modelId: state.modelB.id
  });

  const turnResult = {
    id: Date.now(),
    query,
    retrievedFaq,
    similarityScore,
    modelA: { ...evalA, generatedAnswer: answerA.answer, latencyMs: answerA.latencyMs || 0, modelName: state.modelA.name, modelOrg: state.modelA.org },
    modelB: { ...evalB, generatedAnswer: answerB.answer, latencyMs: answerB.latencyMs || 0, modelName: state.modelB.name, modelOrg: state.modelB.org },
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  if (!state.playgroundChatHistory) {
    state.playgroundChatHistory = [];
  }
  state.playgroundChatHistory.push(turnResult);
  state.playgroundResult = turnResult;
  state.playgroundLoading = false;
  render();

  setTimeout(() => {
    const chatContainer = document.getElementById('playground-chat-feed');
    if (chatContainer) {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    }
  }, 50);
};

window.resetPlaygroundChat = function () {
  state.playgroundChatHistory = [];
  state.playgroundResult = null;
  state.playgroundQuery = '';
  render();
};

window.askPlaygroundSuggestion = function (text) {
  const inputEl = document.getElementById('playground-input');
  if (inputEl) inputEl.value = text;
  runPlayground(text);
};

// Interactive RAG Flow Handlers
window.runRagFlow = async function () {
  const queryInput = document.getElementById('workflow-query-input')?.value;
  const query = queryInput || state.workflowQuery;
  if (!query || !query.trim()) return;

  state.workflowQuery = query;
  state.workflowStatus = 'running';
  state.workflowExecutionData = null;
  state.workflowCurrentStep = 1;
  state.workflowActiveNode = 'query';
  render();

  const delay = ms => new Promise(res => setTimeout(res, ms));

  await delay(350);
  state.workflowCurrentStep = 2;
  state.workflowActiveNode = 'processing';
  render();

  await delay(350);
  const retrievalRes = semanticRetriever.search(query);
  const retrievedFaq = retrievalRes.faq;
  const similarityScore = retrievalRes.similarityScore;

  const allFaqs = clinicFaqs || [];
  const top3Chunks = [
    { rank: 1, id: retrievedFaq.id, topic: retrievedFaq.topic, text: retrievedFaq.context, score: similarityScore },
    ...allFaqs.filter(f => f.id !== retrievedFaq.id).slice(0, 2).map((f, i) => ({
      rank: i + 2,
      id: f.id,
      topic: f.topic,
      text: f.context,
      score: +(similarityScore * (0.75 - i * 0.15)).toFixed(2)
    }))
  ];

  state.workflowCurrentStep = 3;
  state.workflowActiveNode = 'retriever';
  render();

  await delay(400);
  state.workflowCurrentStep = 4;
  state.workflowActiveNode = 'context';
  render();

  await delay(400);
  state.workflowCurrentStep = 5;
  state.workflowActiveNode = 'prompt';
  render();

  await delay(400);
  state.workflowCurrentStep = 6;
  state.workflowActiveNode = 'model';
  render();

  const activeModelId = state.workflowSelectedModelId || state.modelA.id;
  const targetModel = PRESET_MODELS.find(m => m.id === activeModelId) || state.modelA;

  const mockQuestionObj = {
    id: "FLOW-01",
    question: query,
    expected_answer: retrievedFaq.answer,
    expected_faq_id: retrievedFaq.id,
    test_type: "RAG Flow Execution"
  };

  try {
    const modelResponse = await generateAnswer({
      modelId: targetModel.id,
      context: retrievedFaq.context,
      question: query,
      expectedAnswer: retrievedFaq.answer,
      isOutOfScope: false
    });

    state.workflowCurrentStep = 7;
    state.workflowActiveNode = 'answer';
    render();

    await delay(400);
    const evalResult = evaluateResult({
      testQuestion: mockQuestionObj,
      retrievedFaq,
      similarityScore,
      generatedAnswer: modelResponse.answer,
      modelId: targetModel.id
    });

    state.workflowCurrentStep = 8;
    state.workflowActiveNode = 'evaluation';
    state.workflowStatus = 'completed';

    state.workflowExecutionData = {
      query,
      processedQuery: query.trim().toLowerCase(),
      retrievedFaq,
      similarityScore,
      top3Chunks,
      model: targetModel,
      prompt: `You are a clinic information assistant.\n\nAnswer the user's question using ONLY the provided context.\n\nDo not invent information.\n\nCONTEXT:\n${retrievedFaq.context}\n\nUSER QUESTION:\n${query}\n\nANSWER:`,
      generatedAnswer: modelResponse.answer,
      latencyMs: modelResponse.latencyMs || 0,
      evalResult,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    };
  } catch (err) {
    state.workflowStatus = 'error';
  }

  render();
};

window.resetRagFlow = function () {
  state.workflowStatus = 'idle';
  state.workflowCurrentStep = 0;
  state.workflowActiveNode = 'model';
  state.workflowExecutionData = null;
  render();
};

window.selectWorkflowNode = function (nodeKey) {
  state.workflowActiveNode = nodeKey;
  render();
};

window.handleWorkflowModelSelect = function (val) {
  state.workflowSelectedModelId = val;
  render();
};

// Render Main Application UI
function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const prevContentBody = document.querySelector('.content-body');
  const scrollTop = prevContentBody ? prevContentBody.scrollTop : 0;

  const N = testQuestions.length;
  const run = state.latestRun;
  const mA = run ? run.modelA : state.modelA;
  const mB = run ? run.modelB : state.modelB;
  const metricsA = run ? run.metrics.modelA : aggregateMetrics([]);
  const metricsB = run ? run.metrics.modelB : aggregateMetrics([]);

  root.innerHTML = `
    <!-- Sidebar Navigation -->
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="logo-badge">
          <img src="./logo.png" alt="Probe Bench Logo">
        </div>
        <div class="logo-title">
          <h1>Probe Bench</h1>
          <span>Evaluation Lab</span>
        </div>
      </div>
      <div class="nav-section">
        <div class="nav-category">Overview</div>
        <a class="nav-item ${state.currentTab === 'dashboard' ? 'active' : ''}" onclick="switchTab('dashboard')">
          <span>📊</span> Dashboard
        </a>

        <div class="nav-category">Evaluation</div>
        <a class="nav-item ${state.currentTab === 'run' ? 'active' : ''}" onclick="switchTab('run')">
          <span>⚡</span> Live RAG Pipeline Run
        </a>
        <a class="nav-item ${state.currentTab === 'results' ? 'active' : ''}" onclick="switchTab('results')">
          <span>📈</span> Results & Analytics
        </a>
        <a class="nav-item ${state.currentTab === 'playground' ? 'active' : ''}" onclick="switchTab('playground')">
          <span>🧪</span> Live Playground
        </a>

        <div class="nav-category">Knowledge & Data</div>
        <a class="nav-item ${state.currentTab === 'faqs' ? 'active' : ''}" onclick="switchTab('faqs')">
          <span>🏥</span> Knowledge Base
        </a>
        <a class="nav-item ${state.currentTab === 'questions' ? 'active' : ''}" onclick="switchTab('questions')">
          <span>❓</span> (${N}) Benchmark Questions
        </a>

        <div class="nav-category">Workflow</div>
        <a class="nav-item ${state.currentTab === 'workflow' ? 'active' : ''}" onclick="switchTab('workflow')">
          <span>⚡</span> RAG Flow
        </a>

        <div class="nav-category">System</div>
        <a class="nav-item ${state.currentTab === 'config' ? 'active' : ''}" onclick="switchTab('config')">
          <span>⚙️</span> Model Configuration
        </a>
        <a class="nav-item ${state.currentTab === 'about' ? 'active' : ''}" onclick="switchTab('about')">
          <span>📘</span> About Project
        </a>
      </div>
      <div class="sidebar-footer">
        Academic RAG Evaluation System v1.0
      </div>
    </div>

    <!-- Main Wrapper -->
    <div class="main-wrapper">
      <!-- Top Header -->
      <div class="top-header">
        <div class="page-title">
          <h2>${getPageTitle(state.currentTab, N)}</h2>
        </div>
        <div class="header-status">
          <div class="status-badge">
            <div class="status-dot ${state.apiStatus.connected ? '' : 'offline'}"></div>
            Hugging Face API: ${state.apiStatus.connected ? '● Connected' : '● Not Connected'}
          </div>
          <div class="status-badge">
            <span>Model A:</span> <strong>${state.modelA.name}</strong>
          </div>
          <div class="status-badge">
            <span>Model B:</span> <strong>${state.modelB.name}</strong>
          </div>
        </div>
      </div>

      <!-- Main Content Body -->
      <div class="content-body">
        ${renderTabContent(state.currentTab, { mA, mB, metricsA, metricsB, run, N })}
      </div>
    </div>

    <!-- Add Question Modal -->
    ${renderAddQuestionModal()}

    <!-- Question Detail Modal / Drawer -->
    ${renderDetailDrawer()}
  `;

  const newContentBody = document.querySelector('.content-body');
  if (newContentBody && scrollTop) {
    newContentBody.scrollTop = scrollTop;
  }
}

function getPageTitle(tab, N) {
  switch (tab) {
    case 'dashboard': return 'Dashboard Overview';
    case 'run': return `Visual RAG Pipeline (${N} Benchmark Questions)`;
    case 'results': return 'Evaluation Results & Analytics';
    case 'playground': return 'Interactive Multi-Turn RAG Chat Playground';
    case 'workflow': return 'RAG Pipeline — Live Execution';
    case 'faqs': return 'Synthetic Clinic Knowledge Base';
    case 'questions': return `(${N}) Benchmark Test Questions`;
    case 'config': return 'Model Configuration & Hugging Face Setup';
    case 'about': return 'About Academic Evaluation Project';
    default: return 'AI Clinic Assistant Evaluation';
  }
}

function renderTabContent(tab, data) {
  const { mA, mB, metricsA, metricsB, run, N } = data;

  if (tab === 'dashboard') {
    return `
      <!-- Hero Banner -->
      <div class="hero-banner">
        <h3>AI Assistant Evaluation Dashboard</h3>
        <p>Benchmark and head-to-head compare Hugging Face language models using a controlled synthetic clinic RAG knowledge base across 4 core metrics.</p>
        <div class="hero-stats">
          <div class="hero-stat-pill"><span>${N}</span> <label>Benchmark Questions</label></div>
          <div class="hero-stat-pill"><span>25</span> <label>Clinic Knowledge Entries</label></div>
          <div class="hero-stat-pill"><span>2</span> <label>Models Head-to-Head</label></div>
          <div class="hero-stat-pill"><span>4</span> <label>Evaluation Metrics</label></div>
        </div>
      </div>

      <!-- 4 KPI Cards -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">Retrieval Accuracy</span>
            <div class="kpi-icon accuracy">🎯</div>
          </div>
          <div class="kpi-value">${metricsB.retrievalAccuracy}%</div>
          <div class="kpi-subtitle">Correctly retrieved context (${metricsB.retrievalCount})</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">Answer Correctness</span>
            <div class="kpi-icon correctness">✅</div>
          </div>
          <div class="kpi-value">${metricsB.answerCorrectness}%</div>
          <div class="kpi-subtitle">Factually consistent answers (${metricsB.correctnessCount})</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">Answer Relevance</span>
            <div class="kpi-icon relevance">💡</div>
          </div>
          <div class="kpi-value">${metricsB.answerRelevance}%</div>
          <div class="kpi-subtitle">Directly addresses query intent (${metricsB.relevanceCount})</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-header">
            <span class="kpi-title">Hallucination Rate</span>
            <div class="kpi-icon hallucination">⚠️</div>
          </div>
          <div class="kpi-value">${metricsB.hallucinationRate}%</div>
          <div class="kpi-subtitle">Unsupported facts outside context (Lower is better!)</div>
        </div>
      </div>

      <!-- Model Performance Comparison -->
      <div class="comparison-card">
        <div class="section-header">
          <h3>Model Performance Comparison</h3>
          <div class="model-pill-group">
            <div class="model-tag a">Model A: ${mA.name}</div>
            <div class="model-tag b">Model B: ${mB.name}</div>
          </div>
        </div>

        <div class="chart-container">
          ${renderChartRow("Retrieval Accuracy", metricsA.retrievalAccuracy, metricsB.retrievalAccuracy)}
          ${renderChartRow("Answer Correctness", metricsA.answerCorrectness, metricsB.answerCorrectness)}
          ${renderChartRow("Answer Relevance", metricsA.answerRelevance, metricsB.answerRelevance)}
          ${renderChartRow("Hallucination Rate (Lower is Better)", metricsA.hallucinationRate, metricsB.hallucinationRate, true)}
        </div>
      </div>

      <div style="display: flex; gap: 16px;">
        <button class="btn btn-primary" onclick="switchTab('run')">⚡ Run Visual RAG Pipeline</button>
        <button class="btn btn-secondary" onclick="exportCsv()">📥 Export CSV Report</button>
      </div>
    `;
  }

  if (tab === 'run') {
    const completedCount = state.questionPipelineData.filter(d => d.status === 'completed').length;
    const pct = Math.round((completedCount / N) * 100);

    return `
      <div style="max-width: 1050px;">
        <!-- Top Controls Bar -->
        <div class="comparison-card" style="margin-bottom: 20px;">
          <div class="section-header" style="margin-bottom: 16px;">
            <div>
              <h3>Question-by-Question RAG Pipeline Evaluation (${N} Questions)</h3>
              <p style="font-size: 0.85rem; color: var(--text-muted);">Watch the complete RAG process sequentially from Question → Retrieval → Context → Prompt → LLM → Answer → Evaluation.</p>
            </div>
            <span class="badge ${state.evalMode === 'running' ? 'info' : state.evalMode === 'completed' ? 'success' : 'warning'}">
              ${state.evalMode === 'running' ? '● Live Running' : state.evalMode === 'completed' ? '✓ Completed' : '○ Paused / Idle'}
            </span>
          </div>

          <!-- Progress Bar -->
          <div style="margin-bottom: 20px;">
            <div style="display: flex; justify-content: space-between; font-weight: 600; font-size: 0.85rem; margin-bottom: 8px;">
              <span>Question ${state.currentQuestionIndex + 1} of ${N}</span>
              <span>${pct}% Complete (${completedCount}/${N} Evaluated)</span>
            </div>
            <div class="bar-track" style="height: 14px;">
              <div class="bar-fill model-a" style="width: ${pct}%;"></div>
            </div>
          </div>

          <!-- Live Step Status Message -->
          ${state.stepStatusText ? `
            <div style="background: #e0f2fe; padding: 12px 16px; border-radius: var(--radius-md); border: 1px solid #bae6fd; margin-bottom: 20px; font-weight: 600; color: #0369a1; display: flex; align-items: center; gap: 10px;">
              <span class="status-dot"></span> ${state.stepStatusText}
            </div>
          ` : ''}

          <!-- Control Buttons -->
          <div style="display: flex; gap: 12px; flex-wrap: wrap;">
            ${state.evalMode !== 'running' ? `
              <button class="btn btn-primary" onclick="startEvaluation()">🚀 Start Evaluation (${N} Questions)</button>
            ` : `
              <button class="btn btn-secondary" onclick="pauseEvaluation()">⏸️ Pause</button>
            `}
            <button class="btn btn-secondary" onclick="stepNextQuestion()">⏭️ Next Question →</button>
            <button class="btn btn-secondary" onclick="restartEvaluation()">🔄 Restart</button>
            <button class="btn btn-secondary" onclick="openAddQuestionModal()">➕ Add Question (N=${N})</button>
          </div>
        </div>

        <!-- Question Cards List -->
        <div>
          ${state.questionPipelineData.map((item, idx) => renderQuestionPipelineCard(item, idx)).join('')}
        </div>
      </div>
    `;
  }

  if (tab === 'config') {
    return `
      <div style="max-width: 950px;">
        <div class="hero-banner" style="margin-bottom: 24px;">
          <h3>Hugging Face API & Model Configuration</h3>
          <p>Add your Hugging Face API token to connect and run inference with Hugging Face models. Tokens are processed strictly server-side and never exposed to client-side code.</p>
        </div>

        <!-- Connection Status & Token Setup Card -->
        <div class="comparison-card" style="margin-bottom: 24px;">
          <div class="section-header">
            <h3>🔑 API Token Setup & Status</h3>
            <span class="badge ${state.apiStatus.connected ? 'success' : 'danger'}">
              ${state.apiStatus.connected ? '● API Connected' : '● API Token Required'}
            </span>
          </div>

          <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 16px;">
            Add your Hugging Face API token to connect and run inference with Hugging Face models.
          </p>

          <div class="form-group">
            <label>Hugging Face Access Token (Stored securely in .env.local on server)</label>
            <div style="display: flex; gap: 12px;">
              <input type="password" id="token-input" class="form-control" placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxx" value="${state.apiTokenInput}">
              <button class="btn btn-primary" onclick="saveToken()">💾 Save Token</button>
              <button class="btn btn-secondary" onclick="testConnectionClick()">${state.testingConnection ? 'Testing...' : '🔄 Test Connection'}</button>
            </div>
          </div>

          <div style="background: #f8fafc; padding: 16px; border-radius: var(--radius-md); border: 1px solid var(--border); margin-top: 16px;">
            <strong style="font-size: 0.85rem; color: var(--text-main);">Connection Result:</strong>
            <p style="font-size: 0.85rem; color: ${state.apiStatus.connected ? 'var(--success)' : 'var(--danger)'}; margin-top: 4px;">
              ${state.apiStatus.message}
            </p>
          </div>

          <!-- Setup Help Section -->
          <div style="margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border);">
            <h4 style="font-size: 0.95rem; margin-bottom: 12px; color: var(--text-main);">📌 Setup Instructions & Token Guidance:</h4>
            <ol style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.8; padding-left: 20px;">
              <li>Create or log into your account at <a href="https://huggingface.co" target="_blank" style="color: var(--primary);">huggingface.co</a>.</li>
              <li>Navigate to <strong>Settings → Access Tokens</strong> (<a href="https://huggingface.co/settings/tokens" target="_blank" style="color: var(--primary);">huggingface.co/settings/tokens</a>).</li>
              <li>Create a new token with <strong>Read / Inference</strong> permissions.</li>
              <li>Paste the token above or add it to <code>.env.local</code> as <code>HF_TOKEN=hf_...</code>.</li>
              <li>Click <strong>Test Connection</strong> to verify API connectivity.</li>
            </ol>
          </div>
        </div>

        <!-- Model Selectors -->
        <div class="comparison-card">
          <h3 style="margin-bottom: 16px;">🤖 Select Hugging Face Models to Evaluate</h3>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 24px;">
            <!-- Model A Selection -->
            <div style="background: #f8fafc; padding: 20px; border-radius: var(--radius-md); border: 1px solid var(--border);">
              <h4 style="margin-bottom: 12px; color: var(--primary);">Model A Configuration</h4>
              <div class="form-group">
                <label>Select Model A</label>
                <select class="form-control" onchange="handleModelASelect(this.value)">
                  ${PRESET_MODELS.map(m => `<option value="${m.id}" ${state.modelA.id === m.id ? 'selected' : ''}>${m.name} (${m.org})</option>`).join('')}
                  <option value="custom">-- Custom Hugging Face Model ID --</option>
                </select>
              </div>
              <div class="form-group">
                <label>Or Enter Custom HF Model ID</label>
                <input type="text" class="form-control" placeholder="organization/model-name" value="${state.customModelA}" onchange="handleCustomModelAChange(this.value)">
              </div>
            </div>

            <!-- Model B Selection -->
            <div style="background: #f8fafc; padding: 20px; border-radius: var(--radius-md); border: 1px solid var(--border);">
              <h4 style="margin-bottom: 12px; color: #c026d3;">Model B Configuration</h4>
              <div class="form-group">
                <label>Select Model B</label>
                <select class="form-control" onchange="handleModelBSelect(this.value)">
                  ${PRESET_MODELS.map(m => `<option value="${m.id}" ${state.modelB.id === m.id ? 'selected' : ''}>${m.name} (${m.org})</option>`).join('')}
                  <option value="custom">-- Custom Hugging Face Model ID --</option>
                </select>
              </div>
              <div class="form-group">
                <label>Or Enter Custom HF Model ID</label>
                <input type="text" class="form-control" placeholder="organization/model-name" value="${state.customModelB}" onchange="handleCustomModelBChange(this.value)">
              </div>
            </div>
          </div>

          <div style="display: flex; gap: 16px; margin-top: 24px;">
            <button class="btn btn-secondary" onclick="swapModels()">🔄 Swap Models</button>
            <button class="btn btn-primary" style="background: linear-gradient(135deg, #10b981, #059669);" onclick="startEvaluation()">⚡ Run Evaluation Now</button>
          </div>
        </div>
      </div>
    `;
  }

  if (tab === 'results') {
    const resultsList = run ? run.questionResults : [];

    return `
      <div>
        <!-- Top Title Banner -->
        <div class="hero-banner" style="margin-bottom: 24px;">
          <h3>Evaluation Results & Analytics (${N} Benchmark Questions)</h3>
          <p>Head-to-head performance evaluation of Hugging Face models using dynamic visual pie charts, metric breakdowns, and formula explanations.</p>
        </div>

        <!-- 4 KPI Cards -->
        <div class="kpi-grid">
          <div class="kpi-card">
            <span class="kpi-title">Retrieval Accuracy</span>
            <div class="kpi-value" style="color: var(--primary);">${metricsB.retrievalAccuracy}%</div>
            <div class="kpi-subtitle">Model B: ${metricsB.retrievalCount} | Model A: ${metricsA.retrievalAccuracy}%</div>
          </div>
          <div class="kpi-card">
            <span class="kpi-title">Answer Correctness</span>
            <div class="kpi-value" style="color: var(--success);">${metricsB.answerCorrectness}%</div>
            <div class="kpi-subtitle">Model B: ${metricsB.correctnessCount} | Model A: ${metricsA.answerCorrectness}%</div>
          </div>
          <div class="kpi-card">
            <span class="kpi-title">Answer Relevance</span>
            <div class="kpi-value" style="color: var(--accent-cyan);">${metricsB.answerRelevance}%</div>
            <div class="kpi-subtitle">Model B: ${metricsB.relevanceCount} | Model A: ${metricsA.answerRelevance}%</div>
          </div>
          <div class="kpi-card">
            <span class="kpi-title">Hallucination Rate</span>
            <div class="kpi-value" style="color: var(--danger);">${metricsB.hallucinationRate}%</div>
            <div class="kpi-subtitle">Model B: ${metricsB.hallucinationCount} | Model A: ${metricsA.hallucinationRate}%</div>
          </div>
        </div>

        <!-- METRIC 1: RETRIEVAL ACCURACY PIE CHARTS & FORMULA -->
        <div class="comparison-card" style="margin-bottom: 24px;">
          <div class="section-header">
            <h3>🎯 Metric 1 — Retrieval Accuracy Evaluation</h3>
            <span class="badge info">Model A: ${metricsA.retrievalAccuracy}% | Model B: ${metricsB.retrievalAccuracy}%</span>
          </div>
          
          <div style="display: flex; gap: 32px; align-items: center; flex-wrap: wrap;">
            <!-- Side-by-Side Pie Charts -->
            <div style="display: flex; gap: 24px; background: #f8fafc; padding: 20px 28px; border-radius: var(--radius-md); border: 1px solid var(--border);">
              ${renderPieChartSVG(metricsA.retrievalAccuracy, '#4f46e5', `Model A: ${mA.name}`)}
              ${renderPieChartSVG(metricsB.retrievalAccuracy, '#c026d3', `Model B: ${mB.name}`)}
            </div>

            <!-- Formula Box Nearby -->
            <div style="flex: 1; min-width: 300px; background: #eef2ff; padding: 18px 20px; border-radius: var(--radius-md); border-left: 4px solid #4f46e5;">
              <h4 style="font-size: 0.85rem; font-weight: 700; color: #4338ca; text-transform: uppercase; margin-bottom: 6px;">📐 Evaluation Formula Used:</h4>
              <div style="font-family: 'Courier New', monospace; font-size: 0.85rem; font-weight: 700; color: #1e1b4b; background: #ffffff; padding: 8px 12px; border-radius: 6px; border: 1px solid #c7d2fe; margin-bottom: 8px;">
                Retrieval Accuracy = ( Correct Retrievals / Total Questions N ) × 100
              </div>
              <p style="font-size: 0.8rem; color: #4338ca; line-height: 1.4;">
                <strong>Evaluation Criterion:</strong> Checks if <code>Retrieved FAQ ID == Expected FAQ ID</code> for each question.
              </p>
            </div>
          </div>
        </div>

        <!-- METRIC 2: ANSWER CORRECTNESS PIE CHARTS & FORMULA -->
        <div class="comparison-card" style="margin-bottom: 24px;">
          <div class="section-header">
            <h3>✅ Metric 2 — Answer Correctness Evaluation</h3>
            <span class="badge success">Model A: ${metricsA.answerCorrectness}% | Model B: ${metricsB.answerCorrectness}%</span>
          </div>
          
          <div style="display: flex; gap: 32px; align-items: center; flex-wrap: wrap;">
            <!-- Side-by-Side Pie Charts -->
            <div style="display: flex; gap: 24px; background: #f8fafc; padding: 20px 28px; border-radius: var(--radius-md); border: 1px solid var(--border);">
              ${renderPieChartSVG(metricsA.answerCorrectness, '#10b981', `Model A: ${mA.name}`)}
              ${renderPieChartSVG(metricsB.answerCorrectness, '#059669', `Model B: ${mB.name}`)}
            </div>

            <!-- Formula Box Nearby -->
            <div style="flex: 1; min-width: 300px; background: #ecfdf5; padding: 18px 20px; border-radius: var(--radius-md); border-left: 4px solid #10b981;">
              <h4 style="font-size: 0.85rem; font-weight: 700; color: #065f46; text-transform: uppercase; margin-bottom: 6px;">📐 Evaluation Formula Used:</h4>
              <div style="font-family: 'Courier New', monospace; font-size: 0.85rem; font-weight: 700; color: #064e3b; background: #ffffff; padding: 8px 12px; border-radius: 6px; border: 1px solid #a7f3d0; margin-bottom: 8px;">
                Answer Correctness = ( Factually Correct Answers / Total Questions N ) × 100
              </div>
              <p style="font-size: 0.8rem; color: #065f46; line-height: 1.4;">
                <strong>Evaluation Criterion:</strong> Measures factual agreement between generated model output and ground truth reference answer.
              </p>
            </div>
          </div>
        </div>

        <!-- METRIC 3: ANSWER RELEVANCE PIE CHARTS & FORMULA -->
        <div class="comparison-card" style="margin-bottom: 24px;">
          <div class="section-header">
            <h3>💡 Metric 3 — Answer Relevance Evaluation</h3>
            <span class="badge info">Model A: ${metricsA.answerRelevance}% | Model B: ${metricsB.answerRelevance}%</span>
          </div>
          
          <div style="display: flex; gap: 32px; align-items: center; flex-wrap: wrap;">
            <!-- Side-by-Side Pie Charts -->
            <div style="display: flex; gap: 24px; background: #f8fafc; padding: 20px 28px; border-radius: var(--radius-md); border: 1px solid var(--border);">
              ${renderPieChartSVG(metricsA.answerRelevance, '#0ea5e9', `Model A: ${mA.name}`)}
              ${renderPieChartSVG(metricsB.answerRelevance, '#0284c7', `Model B: ${mB.name}`)}
            </div>

            <!-- Formula Box Nearby -->
            <div style="flex: 1; min-width: 300px; background: #e0f2fe; padding: 18px 20px; border-radius: var(--radius-md); border-left: 4px solid #0ea5e9;">
              <h4 style="font-size: 0.85rem; font-weight: 700; color: #0369a1; text-transform: uppercase; margin-bottom: 6px;">📐 Evaluation Formula Used:</h4>
              <div style="font-family: 'Courier New', monospace; font-size: 0.85rem; font-weight: 700; color: #0c4a6e; background: #ffffff; padding: 8px 12px; border-radius: 6px; border: 1px solid #bae6fd; margin-bottom: 8px;">
                Answer Relevance = ( Directly Relevant Answers / Total Questions N ) × 100
              </div>
              <p style="font-size: 0.8rem; color: #0369a1; line-height: 1.4;">
                <strong>Evaluation Criterion:</strong> Verifies whether the response directly addresses the core intent of the user question.
              </p>
            </div>
          </div>
        </div>

        <!-- METRIC 4: HALLUCINATION RATE PIE CHARTS & FORMULA -->
        <div class="comparison-card" style="margin-bottom: 24px;">
          <div class="section-header">
            <h3>⚠️ Metric 4 — Hallucination Rate Evaluation</h3>
            <span class="badge danger">Model A: ${metricsA.hallucinationRate}% | Model B: ${metricsB.hallucinationRate}%</span>
          </div>
          
          <div style="display: flex; gap: 32px; align-items: center; flex-wrap: wrap;">
            <!-- Side-by-Side Pie Charts -->
            <div style="display: flex; gap: 24px; background: #f8fafc; padding: 20px 28px; border-radius: var(--radius-md); border: 1px solid var(--border);">
              ${renderPieChartSVG(metricsA.hallucinationRate, '#ef4444', `Model A: ${mA.name}`)}
              ${renderPieChartSVG(metricsB.hallucinationRate, '#dc2626', `Model B: ${mB.name}`)}
            </div>

            <!-- Formula Box Nearby -->
            <div style="flex: 1; min-width: 300px; background: #fef2f2; padding: 18px 20px; border-radius: var(--radius-md); border-left: 4px solid #ef4444;">
              <h4 style="font-size: 0.85rem; font-weight: 700; color: #991b1b; text-transform: uppercase; margin-bottom: 6px;">📐 Evaluation Formula Used:</h4>
              <div style="font-family: 'Courier New', monospace; font-size: 0.85rem; font-weight: 700; color: #7f1d1d; background: #ffffff; padding: 8px 12px; border-radius: 6px; border: 1px solid #fecaca; margin-bottom: 8px;">
                Hallucination Rate = ( Ungrounded / Hallucinated Answers / Total Questions N ) × 100
              </div>
              <p style="font-size: 0.8rem; color: #991b1b; line-height: 1.4;">
                <strong>Evaluation Criterion:</strong> Detects unsupported facts outside retrieved context or failure to refuse out-of-scope questions (<strong>Lower is Better!</strong>).
              </p>
            </div>
          </div>
        </div>

        <!-- Model Comparison Summary Table & Grouped Bars -->
        <div class="comparison-card">
          <div class="section-header">
            <h3>MODEL COMPARISON SUMMARY TABLE</h3>
            <div class="model-pill-group">
              <div class="model-tag a">Model A: ${mA.name}</div>
              <div class="model-tag b">Model B: ${mB.name}</div>
            </div>
          </div>

          <table class="data-table" style="margin-bottom: 24px;">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Model A (${mA.name})</th>
                <th>Model B (${mB.name})</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Retrieval Accuracy</strong></td>
                <td><strong>${metricsA.retrievalAccuracy}%</strong> (${metricsA.retrievalCount})</td>
                <td><strong>${metricsB.retrievalAccuracy}%</strong> (${metricsB.retrievalCount})</td>
                <td><span class="badge info">Equal</span></td>
              </tr>
              <tr>
                <td><strong>Answer Correctness</strong></td>
                <td><strong>${metricsA.answerCorrectness}%</strong> (${metricsA.correctnessCount})</td>
                <td><strong>${metricsB.answerCorrectness}%</strong> (${metricsB.correctnessCount})</td>
                <td><span class="badge success">${metricsB.answerCorrectness >= metricsA.answerCorrectness ? 'Model B Higher' : 'Model A Higher'}</span></td>
              </tr>
              <tr>
                <td><strong>Answer Relevance</strong></td>
                <td><strong>${metricsA.answerRelevance}%</strong> (${metricsA.relevanceCount})</td>
                <td><strong>${metricsB.answerRelevance}%</strong> (${metricsB.relevanceCount})</td>
                <td><span class="badge success">${metricsB.answerRelevance >= metricsA.answerRelevance ? 'Model B Higher' : 'Model A Higher'}</span></td>
              </tr>
              <tr>
                <td><strong>Hallucination Rate</strong></td>
                <td><strong>${metricsA.hallucinationRate}%</strong> (${metricsA.hallucinationCount})</td>
                <td><strong>${metricsB.hallucinationRate}%</strong> (${metricsB.hallucinationCount})</td>
                <td><span class="badge warning">${metricsB.hallucinationRate <= metricsA.hallucinationRate ? 'Model B Better (Lower)' : 'Model A Better (Lower)'}</span></td>
              </tr>
            </tbody>
          </table>

          <div class="chart-container">
            ${renderChartRow("Retrieval Accuracy", metricsA.retrievalAccuracy, metricsB.retrievalAccuracy)}
            ${renderChartRow("Answer Correctness", metricsA.answerCorrectness, metricsB.answerCorrectness)}
            ${renderChartRow("Answer Relevance", metricsA.answerRelevance, metricsB.answerRelevance)}
            ${renderChartRow("Hallucination Rate (Lower is Better)", metricsA.hallucinationRate, metricsB.hallucinationRate, true)}
          </div>
        </div>
                <td><span class="badge warning">${metricsB.hallucinationRate <= metricsA.hallucinationRate ? 'Model B Better (Lower)' : 'Model A Better (Lower)'}</span></td>
              </tr>
            </tbody>
          </table>

          <div class="chart-container">
            ${renderChartRow("Retrieval Accuracy", metricsA.retrievalAccuracy, metricsB.retrievalAccuracy)}
            ${renderChartRow("Answer Correctness", metricsA.answerCorrectness, metricsB.answerCorrectness)}
            ${renderChartRow("Answer Relevance", metricsA.answerRelevance, metricsB.answerRelevance)}
            ${renderChartRow("Hallucination Rate (Lower is Better)", metricsA.hallucinationRate, metricsB.hallucinationRate, true)}
          </div>
        </div>

        <!-- Question-Level Results Table -->
        <div class="table-card">
          <div class="section-header" style="padding: 20px 24px; border-bottom: 1px solid var(--border); margin-bottom: 0;">
            <h3>Question-Level Results Breakdown (Click any row to inspect detail)</h3>
            <button class="btn btn-secondary" onclick="exportCsv()">📥 Export CSV Report</button>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Test Question</th>
                <th>Retrieved FAQ</th>
                <th>Similarity</th>
                <th>Model A Correctness</th>
                <th>Model B Correctness</th>
                <th>Model A Hallucination</th>
                <th>Model B Hallucination</th>
              </tr>
            </thead>
            <tbody>
              ${resultsList.map((item, idx) => `
                <tr onclick="openQuestionDetail(${idx})">
                  <td><strong>${item.question.id}</strong></td>
                  <td style="font-weight: 600;">${item.question.question}</td>
                  <td><span class="badge info">${item.retrievedFaq.id}</span></td>
                  <td><strong>${item.similarityScore}</strong></td>
                  <td><span class="badge ${item.modelA.answerCorrect ? 'success' : 'danger'}">${item.modelA.answerCorrect ? '✓ Correct' : '✗ Incorrect'}</span></td>
                  <td><span class="badge ${item.modelB.answerCorrect ? 'success' : 'danger'}">${item.modelB.answerCorrect ? '✓ Correct' : '✗ Incorrect'}</span></td>
                  <td><span class="badge ${item.modelA.hallucinationDetected ? 'danger' : 'success'}">${item.modelA.hallucinationDetected ? '⚠️ Yes' : '✓ No'}</span></td>
                  <td><span class="badge ${item.modelB.hallucinationDetected ? 'danger' : 'success'}">${item.modelB.hallucinationDetected ? '⚠️ Yes' : '✓ No'}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  if (tab === 'playground') {
    const chatHistory = state.playgroundChatHistory || [];

    return `
      <div style="max-width: 960px; margin: 0 auto;">
        <div class="hero-banner" style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <h3 style="display: flex; align-items: center; gap: 8px;">
              <span>💬 Multi-Turn RAG Playground Chat</span>
              <span class="badge info">${chatHistory.length} ${chatHistory.length === 1 ? 'Question' : 'Questions'} Asked</span>
            </h3>
            <p style="margin-top: 4px;">Ask clinic questions multiple times, change models on-the-fly, test follow-ups, and evaluate model responses in real-time.</p>
          </div>
          ${chatHistory.length > 0 ? `
            <button class="btn btn-secondary" onclick="resetPlaygroundChat()" style="background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; font-weight: 600;">
              🔄 Reset Chat Conversation
            </button>
          ` : ''}
        </div>

        <div class="comparison-card" style="padding: 0; overflow: hidden; border: 1px solid var(--border); box-shadow: var(--shadow-md);">
          <!-- Top Chat Header Bar with Model Selector Panel -->
          <div style="background: #0f172a; color: #ffffff; padding: 20px 24px; border-bottom: 1px solid #1e293b;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; margin-bottom: 16px;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-size: 1.4rem;">🤖</span>
                <div>
                  <div style="font-weight: 700; font-size: 1rem; color: #ffffff;">Active Chat Model Configuration</div>
                  <div style="font-size: 0.8rem; color: #94a3b8;">Select models below to switch and compare responses live</div>
                </div>
              </div>
              <div style="display: flex; gap: 10px; align-items: center;">
                <button onclick="swapModels()" class="btn" style="padding: 6px 14px; font-size: 0.8rem; background: rgba(79, 70, 229, 0.3); color: #c7d2fe; border: 1px solid rgba(99, 102, 241, 0.5); font-weight: 600;">
                  🔀 Swap Models
                </button>
                ${chatHistory.length > 0 ? `
                  <button onclick="resetPlaygroundChat()" class="btn" style="padding: 6px 14px; font-size: 0.8rem; background: rgba(239, 68, 68, 0.2); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); font-weight: 600;">
                    🔄 Clear & Reset
                  </button>
                ` : ''}
              </div>
            </div>

            <!-- Model Selector Dropdowns Grid -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; background: rgba(255,255,255,0.05); padding: 14px 18px; border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.1);">
              <!-- Model A Dropdown -->
              <div style="display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <label style="font-size: 0.78rem; font-weight: 700; color: #818cf8; text-transform: uppercase; letter-spacing: 0.05em;">
                    🤖 Model A (Left)
                  </label>
                  <span style="font-size: 0.72rem; color: #94a3b8;">Current: <strong>${mA.name}</strong></span>
                </div>
                <select class="form-control" style="background: #1e293b; color: #ffffff; border: 1px solid #475569; font-size: 0.85rem;" onchange="handleModelASelect(this.value)">
                  ${PRESET_MODELS.map(m => `<option value="${m.id}" ${state.modelA.id === m.id ? 'selected' : ''}>${m.name} (${m.org})</option>`).join('')}
                </select>
              </div>

              <!-- Model B Dropdown -->
              <div style="display: flex; flex-direction: column; gap: 6px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <label style="font-size: 0.78rem; font-weight: 700; color: #f0abfc; text-transform: uppercase; letter-spacing: 0.05em;">
                    🤖 Model B (Right)
                  </label>
                  <span style="font-size: 0.72rem; color: #94a3b8;">Current: <strong>${mB.name}</strong></span>
                </div>
                <select class="form-control" style="background: #1e293b; color: #ffffff; border: 1px solid #475569; font-size: 0.85rem;" onchange="handleModelBSelect(this.value)">
                  ${PRESET_MODELS.map(m => `<option value="${m.id}" ${state.modelB.id === m.id ? 'selected' : ''}>${m.name} (${m.org})</option>`).join('')}
                </select>
              </div>
            </div>
          </div>

          <!-- Chat Conversation Scroll Area -->
          <div id="playground-chat-feed" style="height: 580px; max-height: 580px; overflow-y: auto; padding: 24px; background: #f8fafc; display: flex; flex-direction: column; gap: 24px;">
            ${chatHistory.length === 0 && !state.playgroundLoading ? `
              <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                <div style="font-size: 3rem; margin-bottom: 12px;">💬</div>
                <h4 style="color: var(--text-main); font-size: 1.1rem; margin-bottom: 8px;">No Conversation Started Yet</h4>
                <p style="max-width: 500px; margin: 0 auto 20px auto; font-size: 0.9rem;">
                  Type any custom question below to test real-time RAG retrieval, similarity score, prompt construction, and compare outputs from <strong>${mA.name}</strong> vs <strong>${mB.name}</strong>.
                </p>

                <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; max-width: 650px; margin: 0 auto;">
                  <button class="btn btn-secondary" onclick="askPlaygroundSuggestion('Can I pay using Apple Pay at the clinic pharmacy?')" style="font-size: 0.82rem; background: #ffffff; border: 1px solid #cbd5e1;">
                    💡 "Can I pay using Apple Pay at the pharmacy?"
                  </button>
                  <button class="btn btn-secondary" onclick="askPlaygroundSuggestion('What are the weekend operating hours for general checkups?')" style="font-size: 0.82rem; background: #ffffff; border: 1px solid #cbd5e1;">
                    💡 "What are the weekend operating hours?"
                  </button>
                  <button class="btn btn-secondary" onclick="askPlaygroundSuggestion('Is emergency dental treatment covered under health insurance?')" style="font-size: 0.82rem; background: #ffffff; border: 1px solid #cbd5e1;">
                    💡 "Is emergency dental care covered by insurance?"
                  </button>
                </div>
              </div>
            ` : ''}

            ${chatHistory.map((turn, idx) => `
              <div style="background: #ffffff; border-radius: var(--radius-lg); border: 1px solid #e2e8f0; box-shadow: 0 2px 8px rgba(0,0,0,0.04); overflow: hidden; flex-shrink: 0;">
                <!-- User Question Header -->
                <div style="background: #f1f5f9; padding: 14px 20px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="badge primary" style="font-weight: 700;">Q${idx + 1}</span>
                    <strong style="color: #0f172a; font-size: 0.95rem;">💬 ${turn.query}</strong>
                  </div>
                  <span style="font-size: 0.75rem; color: #64748b;">${turn.timestamp || ''}</span>
                </div>

                <div style="padding: 20px;">
                  <!-- Retrieved Context Box -->
                  <div style="background: #f8fafc; padding: 12px 16px; border-radius: var(--radius-md); border-left: 4px solid var(--primary); font-size: 0.88rem; margin-bottom: 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                      <span style="font-weight: 700; color: var(--primary);">🔍 Retrieved KB Match: ${turn.retrievedFaq.id} (${turn.retrievedFaq.topic})</span>
                      <span class="badge info">Cosine Similarity: ${turn.similarityScore}</span>
                    </div>
                    <div style="max-height: 90px; overflow-y: auto; padding-right: 4px;">
                      <p style="color: #334155; line-height: 1.45; margin: 0;">${turn.retrievedFaq.context}</p>
                    </div>
                  </div>

                  <!-- Models Responses Grid -->
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                    <!-- Model A -->
                    <div style="background: #eef2ff; padding: 14px 16px; border-radius: var(--radius-md); border: 1px solid #c7d2fe; display: flex; flex-direction: column; justify-content: space-between; min-height: 215px; box-sizing: border-box;">
                      <div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                          <h5 style="color: #4f46e5; margin: 0; font-size: 0.88rem; display: flex; align-items: center; gap: 6px;">
                            <span>🤖 Model A:</span>
                            <span style="font-weight: 700; color: #3730a3;">${turn.modelA.modelName || mA.name}</span>
                          </h5>
                          <span style="font-size: 0.72rem; background: #ffffff; padding: 2px 6px; border-radius: 4px; color: #4338ca; border: 1px solid #c7d2fe;">${turn.modelA.latencyMs || 0}ms</span>
                        </div>
                        <div style="height: 110px; max-height: 110px; overflow-y: auto; padding: 8px 10px; background: #ffffff; border-radius: 6px; border: 1px solid #c7d2fe;">
                          <p style="font-size: 0.85rem; color: #1e1b4b; line-height: 1.45; margin: 0; white-space: pre-wrap;">"${turn.modelA.generatedAnswer}"</p>
                        </div>
                      </div>
                      <div style="display: flex; gap: 6px; flex-wrap: wrap; border-top: 1px solid #c7d2fe; padding-top: 8px; margin-top: 6px;">
                        <span class="badge ${turn.modelA.answerCorrect ? 'success' : 'danger'}">Correctness: ${turn.modelA.answerCorrect ? '✓ Match' : '✗ Incorrect'}</span>
                        <span class="badge ${turn.modelA.hallucinationDetected ? 'danger' : 'success'}">Hallucination: ${turn.modelA.hallucinationDetected ? 'Detected' : 'None'}</span>
                      </div>
                    </div>

                    <!-- Model B -->
                    <div style="background: #fae8ff; padding: 14px 16px; border-radius: var(--radius-md); border: 1px solid #f5d0fe; display: flex; flex-direction: column; justify-content: space-between; min-height: 215px; box-sizing: border-box;">
                      <div>
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                          <h5 style="color: #c026d3; margin: 0; font-size: 0.88rem; display: flex; align-items: center; gap: 6px;">
                            <span>🤖 Model B:</span>
                            <span style="font-weight: 700; color: #86198f;">${turn.modelB.modelName || mB.name}</span>
                          </h5>
                          <span style="font-size: 0.72rem; background: #ffffff; padding: 2px 6px; border-radius: 4px; color: #a21caf; border: 1px solid #f5d0fe;">${turn.modelB.latencyMs || 0}ms</span>
                        </div>
                        <div style="height: 110px; max-height: 110px; overflow-y: auto; padding: 8px 10px; background: #ffffff; border-radius: 6px; border: 1px solid #f5d0fe;">
                          <p style="font-size: 0.85rem; color: #701a75; line-height: 1.45; margin: 0; white-space: pre-wrap;">"${turn.modelB.generatedAnswer}"</p>
                        </div>
                      </div>
                      <div style="display: flex; gap: 6px; flex-wrap: wrap; border-top: 1px solid #f5d0fe; padding-top: 8px; margin-top: 6px;">
                        <span class="badge ${turn.modelB.answerCorrect ? 'success' : 'danger'}">Correctness: ${turn.modelB.answerCorrect ? '✓ Match' : '✗ Incorrect'}</span>
                        <span class="badge ${turn.modelB.hallucinationDetected ? 'danger' : 'success'}">Hallucination: ${turn.modelB.hallucinationDetected ? 'Detected' : 'None'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            `).join('')}

            ${state.playgroundLoading ? `
              <div style="background: #ffffff; padding: 20px; border-radius: var(--radius-lg); border: 1px solid #cbd5e1; text-align: center; color: var(--primary);">
                <div style="display: inline-block; animation: spin 1s linear infinite; font-size: 1.5rem; margin-bottom: 8px;">⏳</div>
                <div style="font-weight: 600; font-size: 0.95rem;">Retrieving vector embeddings & generating dual model completions...</div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">Chatting with <strong>${mA.name}</strong> vs <strong>${mB.name}</strong></div>
              </div>
            ` : ''}
          </div>

          <!-- Bottom Sticky Chat Input Bar -->
          <div style="background: #ffffff; padding: 20px 24px; border-top: 1px solid var(--border);">
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                <label style="font-weight: 600; font-size: 0.85rem; color: var(--text-muted);">
                  Ask a question or follow-up:
                </label>
                <div style="font-size: 0.8rem; color: var(--text-muted); display: flex; gap: 12px; align-items: center;">
                  <span>Active LLMs: <strong style="color: #4f46e5;">${mA.name}</strong> vs <strong style="color: #c026d3;">${mB.name}</strong></span>
                  ${chatHistory.length > 0 ? `<span>Questions asked: <strong>${chatHistory.length}</strong></span>` : ''}
                </div>
              </div>
              <div style="display: flex; gap: 12px; align-items: center;">
                <input type="text" id="playground-input" class="form-control" 
                       placeholder="e.g. Can I get a copy of my medical records online?" 
                       value="${state.playgroundQuery}" 
                       onkeydown="if(event.key === 'Enter') runPlayground()"
                       ${state.playgroundLoading ? 'disabled' : ''}>
                <button class="btn btn-primary" style="white-space: nowrap; font-weight: 600; display: flex; align-items: center; gap: 6px;" 
                        onclick="runPlayground()" ${state.playgroundLoading ? 'disabled' : ''}>
                  <span>💬</span> Ask Assistant
                </button>
                ${chatHistory.length > 0 ? `
                  <button class="btn btn-secondary" style="white-space: nowrap; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca;" 
                          onclick="resetPlaygroundChat()" ${state.playgroundLoading ? 'disabled' : ''}>
                    🔄 Reset Chat
                  </button>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (tab === 'faqs') {
    return `
      <div>
        <div style="margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h3>Synthetic Clinic Knowledge Base (${clinicFaqs.length} Entries)</h3>
            <p style="font-size: 0.85rem; color: var(--text-muted);">All clinic information is synthetic and created exclusively for academic evaluation.</p>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px;">
          ${clinicFaqs.map(faq => `
            <div class="kpi-card" style="border-top: 4px solid var(--primary);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <span class="badge info">${faq.id}</span>
                <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted);">${faq.topic}</span>
              </div>
              <h4 style="font-size: 0.95rem; margin-bottom: 8px;">${faq.question}</h4>
              <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.4; margin-bottom: 12px;">${faq.context}</p>
              <div style="font-size: 0.8rem; background: #f8fafc; padding: 8px 12px; border-radius: var(--radius-sm); border-left: 3px solid var(--success);">
                <strong>Answer:</strong> ${faq.answer}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (tab === 'questions') {
    return `
      <div class="table-card">
        <div class="section-header" style="padding: 20px 24px; border-bottom: 1px solid var(--border); margin-bottom: 0;">
          <div>
            <h3>(${N}) Benchmark Test Questions</h3>
            <p style="font-size: 0.85rem; color: var(--text-muted);">Standardized question suite evaluated against the clinic knowledge base.</p>
          </div>
          <div style="display: flex; gap: 12px;">
            <button class="btn btn-primary" onclick="openAddQuestionModal()">➕ Add Question (N=${N})</button>
            <button class="btn btn-secondary" onclick="resetBenchmarkQuestions()">🔄 Reset to Default 20</button>
          </div>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Question</th>
              <th>Test Type</th>
              <th>Expected FAQ</th>
              <th>Expected Ground Truth Answer</th>
            </tr>
          </thead>
          <tbody>
            ${testQuestions.map(q => `
              <tr>
                <td><strong>${q.id}</strong></td>
                <td style="font-weight: 600;">${q.question}</td>
                <td><span class="badge warning">${q.test_type}</span></td>
                <td><span class="badge info">${q.expected_faq_id}</span></td>
                <td style="max-width: 300px;">${q.expected_answer}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (tab === 'workflow') {
    const d = state.workflowExecutionData;
    const step = state.workflowCurrentStep;
    const status = state.workflowStatus;
    const activeModelId = state.workflowSelectedModelId || state.modelA.id;
    const activeModel = PRESET_MODELS.find(m => m.id === activeModelId) || state.modelA;
    const activeNode = state.workflowActiveNode || 'model';

    const getNodeState = (nodeStep) => {
      if (status === 'error' && step === nodeStep) return { label: 'Error', icon: '⚠️', badgeClass: 'danger' };
      if (status === 'running' && step === nodeStep) return { label: 'Processing', icon: '●', badgeClass: 'info' };
      if (step >= nodeStep && step > 0) return { label: 'Completed', icon: '✓', badgeClass: 'success' };
      return { label: 'Waiting', icon: '○', badgeClass: 'secondary' };
    };

    const node1 = getNodeState(1);
    const node2 = getNodeState(2);
    const node3 = getNodeState(3);
    const node4 = getNodeState(4);
    const node5 = getNodeState(5);
    const node6 = getNodeState(6);
    const node7 = getNodeState(7);
    const node8 = getNodeState(8);

    return `
      <div style="max-width: 1200px; margin: 0 auto;">
        <!-- Page Hero Banner -->
        <div class="hero-banner" style="margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px;">
          <div>
            <h3>RAG Pipeline — Live Execution</h3>
            <p style="margin-top: 4px;">"Visualize how a question moves through retrieval, context construction, model inference, and evaluation."</p>
          </div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <button class="btn btn-primary" onclick="runRagFlow()" ${status === 'running' ? 'disabled' : ''} style="font-weight: 600;">
              ⚡ Run Live RAG Flow
            </button>
            <button class="btn btn-secondary" onclick="resetRagFlow()" ${status === 'running' ? 'disabled' : ''} style="background: #ffffff; border: 1px solid #cbd5e1;">
              🔄 Reset Flow
            </button>
          </div>
        </div>

        <!-- Controls Bar for Selecting Question & Model -->
        <div class="comparison-card" style="margin-bottom: 20px; padding: 16px 20px; background: #ffffff;">
          <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 16px; align-items: center;">
            <div>
              <label style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">
                Select Test Question or Type Custom Query:
              </label>
              <input type="text" id="workflow-query-input" class="form-control" 
                     placeholder="Type a test question..." 
                     value="${state.workflowQuery}"
                     onchange="state.workflowQuery = this.value">
            </div>
            <div>
              <label style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px; display: block;">
                Selected LLM / Model:
              </label>
              <select class="form-control" onchange="handleWorkflowModelSelect(this.value)">
                ${PRESET_MODELS.map(m => `<option value="${m.id}" ${activeModelId === m.id ? 'selected' : ''}>${m.name} (${m.org})</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <!-- Main Layout: 2 Columns (Pipeline Visualizer + Details Side Panels) -->
        <div style="display: grid; grid-template-columns: 7fr 5fr; gap: 24px;">

          <!-- Column 1: Vertical 8-Stage Visual Pipeline Diagram -->
          <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="font-weight: 700; font-size: 0.9rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
              Live Pipeline Stages (Click any node to inspect details)
            </div>

            <!-- Node 1: User Query -->
            <div class="flow-node-card ${activeNode === 'query' ? 'active' : ''}" onclick="selectWorkflowNode('query')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">💬</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">1. USER QUERY</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">"${state.workflowQuery}"</div>
                  </div>
                </div>
                <span class="badge ${node1.badgeClass}">${node1.icon} ${node1.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 2: Query Processing -->
            <div class="flow-node-card ${activeNode === 'processing' ? 'active' : ''}" onclick="selectWorkflowNode('processing')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">⚙️</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">2. QUERY PROCESSING</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">TF-IDF Tokenization & Normalization</div>
                  </div>
                </div>
                <span class="badge ${node2.badgeClass}">${node2.icon} ${node2.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 3: Retriever -->
            <div class="flow-node-card ${activeNode === 'retriever' ? 'active' : ''}" onclick="selectWorkflowNode('retriever')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">🔍</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">3. RETRIEVER</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">Vector Search KB (${clinicFaqs.length} FAQs)</div>
                  </div>
                </div>
                <span class="badge ${node3.badgeClass}">${node3.icon} ${node3.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 4: Retrieved Context -->
            <div class="flow-node-card ${activeNode === 'context' ? 'active' : ''}" onclick="selectWorkflowNode('context')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">📄</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">4. RETRIEVED CONTEXT</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">${d ? `Top Match: ${d.retrievedFaq.id} (${d.retrievedFaq.topic})` : 'Top relevant chunks'}</div>
                  </div>
                </div>
                <span class="badge ${node4.badgeClass}">${node4.icon} ${node4.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 5: Prompt Augmentation -->
            <div class="flow-node-card ${activeNode === 'prompt' ? 'active' : ''}" onclick="selectWorkflowNode('prompt')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">📝</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">5. PROMPT AUGMENTATION</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">Grounded System Instructions + Context + Query</div>
                  </div>
                </div>
                <span class="badge ${node5.badgeClass}">${node5.icon} ${node5.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 6: LLM / MODEL (EXPLICIT MODEL DISPLAY) -->
            <div class="flow-node-card ${activeNode === 'model' ? 'active' : ''}" style="background: #0f172a; color: #ffffff; border: 2px solid #414868;" onclick="selectWorkflowNode('model')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 12px;">
                  <span style="font-size: 1.4rem;">🤖</span>
                  <div>
                    <div style="font-weight: 700; font-size: 1rem; color: #38bdf8;">6. LLM / MODEL</div>
                    <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 2px;">
                      Provider: <strong style="color: #ffffff;">Hugging Face</strong> | Model: <strong style="color: #818cf8;">${activeModel.id}</strong>
                    </div>
                  </div>
                </div>
                <span class="badge ${node6.badgeClass}">${node6.icon} ${node6.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 7: Generated Answer -->
            <div class="flow-node-card ${activeNode === 'answer' ? 'active' : ''}" onclick="selectWorkflowNode('answer')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">✨</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">7. GENERATED ANSWER</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">${d ? `"${d.generatedAnswer.substring(0, 45)}..."` : 'Model Output Response'}</div>
                  </div>
                </div>
                <span class="badge ${node7.badgeClass}">${node7.icon} ${node7.label}</span>
              </div>
            </div>

            <div style="text-align: center; color: var(--primary); font-size: 1.2rem; font-weight: bold; line-height: 1;">↓</div>

            <!-- Node 8: Evaluation -->
            <div class="flow-node-card ${activeNode === 'evaluation' ? 'active' : ''}" onclick="selectWorkflowNode('evaluation')">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 10px;">
                  <span style="font-size: 1.2rem;">📊</span>
                  <div>
                    <div style="font-weight: 700; font-size: 0.95rem;">8. EVALUATION</div>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">Accuracy, Correctness, Relevance, Hallucination-Free</div>
                  </div>
                </div>
                <span class="badge ${node8.badgeClass}">${node8.icon} ${node8.label}</span>
              </div>
            </div>
          </div>

          <!-- Column 2: Stacked Execution Details Panel & Node Inspector -->
          <div style="display: flex; flex-direction: column; gap: 20px;">

            <!-- Execution Details Side Panel -->
            <div class="comparison-card" style="padding: 20px; background: #ffffff;">
              <h4 style="font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 14px; display: flex; align-items: center; gap: 8px;">
                <span>📋 Execution Details Side Panel</span>
              </h4>
              <div style="display: flex; flex-direction: column; gap: 10px; font-size: 0.88rem;">
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">CURRENT QUERY:</span>
                  <strong style="max-width: 200px; text-align: right; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">"${state.workflowQuery}"</strong>
                </div>
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">SELECTED MODEL:</span>
                  <strong style="color: var(--primary);">${activeModel.name}</strong>
                </div>
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">MODEL ID:</span>
                  <code style="font-size: 0.75rem; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${activeModel.id}</code>
                </div>
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">PROVIDER:</span>
                  <strong>Hugging Face Inference API</strong>
                </div>
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">PIPELINE STATUS:</span>
                  <span class="badge ${status === 'completed' ? 'success' : (status === 'running' ? 'info' : (status === 'error' ? 'danger' : 'secondary'))}">${status.toUpperCase()}</span>
                </div>
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">RETRIEVED CHUNKS:</span>
                  <strong>${d ? d.top3Chunks.length : 0} Chunks</strong>
                </div>
                <div style="display: flex; justify-content: space-between; border-bottom: 1px dashed #e2e8f0; padding-bottom: 6px;">
                  <span style="color: var(--text-muted);">RESPONSE STATUS:</span>
                  <strong>${d ? '✓ Success (' + d.latencyMs + 'ms)' : (status === 'running' ? '● Processing...' : 'Pending')}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                  <span style="color: var(--text-muted);">EVALUATION STATUS:</span>
                  <strong>${d ? '✓ Completed' : 'Pending'}</strong>
                </div>
              </div>
            </div>

            <!-- Node Inspector Detail Panel -->
            <div class="comparison-card" style="padding: 20px; background: #ffffff;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                <h4 style="font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--primary);">
                  🔍 Node Inspector: ${activeNode.toUpperCase()}
                </h4>
                <span class="badge info" style="font-size: 0.75rem;">Click nodes to switch</span>
              </div>

              ${activeNode === 'query' ? `
                <div>
                  <h5 style="margin-bottom: 6px;">User Question</h5>
                  <div style="background: #f8fafc; padding: 12px; border-radius: var(--radius-sm); font-size: 0.9rem; margin-bottom: 12px;">"${state.workflowQuery}"</div>
                  <div style="font-size: 0.8rem; color: var(--text-muted);">
                    <div>Character Length: <strong>${state.workflowQuery.length}</strong></div>
                    <div>Query Type: <strong>Interactive Demonstration Input</strong></div>
                  </div>
                </div>
              ` : ''}

              ${activeNode === 'processing' ? `
                <div>
                  <h5 style="margin-bottom: 6px;">Query Preprocessing</h5>
                  <div style="background: #f8fafc; padding: 12px; border-radius: var(--radius-sm); font-size: 0.85rem; margin-bottom: 12px;">
                    <div>Normalized Input: <code>"${d ? d.processedQuery : state.workflowQuery.trim().toLowerCase()}"</code></div>
                    <div style="margin-top: 4px;">Vector Algorithm: <strong>TF-IDF & Cosine Similarity</strong></div>
                  </div>
                </div>
              ` : ''}

              ${activeNode === 'retriever' ? `
                <div>
                  <h5 style="margin-bottom: 6px;">RETRIEVAL DETAILS</h5>
                  <div style="font-size: 0.85rem; margin-bottom: 8px;">
                    <div>Query: <strong>"${state.workflowQuery}"</strong></div>
                    <div>Documents Retrieved: <strong>${d ? d.top3Chunks.length : 3}</strong></div>
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto;">
                    ${(d ? d.top3Chunks : [
                      { rank: 1, id: 'FAQ-001', topic: 'Clinic Hours', text: 'HopeWell Family Clinic operates Monday to Friday from 8:00 AM to 8:00 PM, Saturdays 9:00 AM to 5:00 PM...', score: 0.92 },
                      { rank: 2, id: 'FAQ-005', topic: 'Appointments', text: 'Walk-ins are accepted for urgent care, though appointments are recommended...', score: 0.74 },
                      { rank: 3, id: 'FAQ-012', topic: 'Services', text: 'General checkups and pediatric care are offered during operating hours...', score: 0.58 }
                    ]).map(c => `
                      <div style="background: #f8fafc; padding: 10px; border-radius: var(--radius-sm); border-left: 3px solid var(--primary); font-size: 0.8rem;">
                        <div style="display: flex; justify-content: space-between; font-weight: 700; margin-bottom: 2px;">
                          <span>Chunk ${c.rank} (${c.id} - ${c.topic})</span>
                          <span style="color: var(--primary);">Similarity: ${c.score}</span>
                        </div>
                        <div style="color: var(--text-muted);">${c.text}</div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              ` : ''}

              ${activeNode === 'context' ? `
                <div>
                  <h5 style="margin-bottom: 6px;">CONTEXT SENT TO MODEL</h5>
                  <div style="background: #f1f5f9; padding: 12px; border-radius: var(--radius-sm); font-size: 0.85rem; line-height: 1.5; margin-bottom: 12px; max-height: 180px; overflow-y: auto;">
                    ${d ? d.retrievedFaq.context : 'Retrieved context passages will appear here when pipeline runs...'}
                  </div>
                  <div style="font-size: 0.8rem; background: #eef2ff; color: #3730a3; padding: 10px; border-radius: var(--radius-sm); border-left: 3px solid #4f46e5;">
                    💡 <em>"These retrieved passages are supplied to the language model as context for generating the answer."</em>
                  </div>
                </div>
              ` : ''}

              ${activeNode === 'prompt' ? `
                <div>
                  <h5 style="margin-bottom: 6px;">AUGMENTED PROMPT STRUCTURE</h5>
                  <div style="background: #0f172a; color: #38bdf8; font-family: monospace; font-size: 0.78rem; padding: 12px; border-radius: var(--radius-sm); white-space: pre-wrap; max-height: 240px; overflow-y: auto; line-height: 1.4;">
${d ? d.prompt : `You are a clinic information assistant.

Answer the user's question using ONLY the provided context.

Do not invent information.

CONTEXT:
[retrieved passages inserted here]

USER QUESTION:
${state.workflowQuery}

ANSWER:`}
                  </div>
                  <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 6px;">Read-only prompt schema. API credentials and bearer tokens are strictly omitted.</div>
                </div>
              ` : ''}

              ${activeNode === 'model' ? `
                <div>
                  <h5 style="margin-bottom: 6px; color: var(--primary);">MODEL INFERENCE DETAILS</h5>
                  <div style="background: #0f172a; color: #ffffff; padding: 14px; border-radius: var(--radius-sm); font-size: 0.85rem; display: flex; flex-direction: column; gap: 8px;">
                    <div>Provider: <strong style="color: #38bdf8;">Hugging Face Inference API</strong></div>
                    <div>Model Identifier: <strong style="color: #818cf8;">${activeModel.id}</strong></div>
                    <div>Model Name: <strong>${activeModel.name} (${activeModel.org})</strong></div>
                    <div>Request Status: <span class="badge ${d ? 'success' : (status === 'running' ? 'info' : 'secondary')}">${d ? '✓ Success (' + d.latencyMs + 'ms)' : (status === 'running' ? '● Processing...' : 'Waiting')}</span></div>
                  </div>
                </div>
              ` : ''}

              ${activeNode === 'answer' ? `
                <div>
                  <h5 style="margin-bottom: 6px;">GENERATED ANSWER</h5>
                  <div style="background: #ecfdf5; border: 1px solid #a7f3d0; padding: 14px; border-radius: var(--radius-sm); font-size: 0.88rem; color: #065f46; line-height: 1.5; margin-bottom: 10px; max-height: 180px; overflow-y: auto;">
                    "${d ? d.generatedAnswer : 'Model output answer will be displayed here...'}"
                  </div>
                  <div style="font-size: 0.78rem; color: var(--text-muted);">Distinguished completion output directly returned from Hugging Face model endpoint.</div>
                </div>
              ` : ''}

              ${activeNode === 'evaluation' ? `
                <div>
                  <h5 style="margin-bottom: 8px;">EVALUATION METRICS</h5>
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 0.82rem;">
                    <div style="background: #f8fafc; padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                      <div style="color: var(--text-muted);">Retrieval Accuracy</div>
                      <strong style="font-size: 1rem; color: var(--primary);">${d ? (d.evalResult.retrievalCorrect ? '100%' : '0%') : 'Not evaluated'}</strong>
                    </div>
                    <div style="background: #f8fafc; padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                      <div style="color: var(--text-muted);">Answer Correctness</div>
                      <strong style="font-size: 1rem; color: var(--success);">${d ? (d.evalResult.answerCorrect ? '100%' : '0%') : 'Not evaluated'}</strong>
                    </div>
                    <div style="background: #f8fafc; padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                      <div style="color: var(--text-muted);">Answer Relevance</div>
                      <strong style="font-size: 1rem; color: var(--accent-cyan);">${d ? (d.evalResult.answerRelevance ? '100%' : '0%') : 'Not evaluated'}</strong>
                    </div>
                    <div style="background: #f8fafc; padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                      <div style="color: var(--text-muted);">Hallucination-Free</div>
                      <strong style="font-size: 1rem; color: ${d ? (d.evalResult.hallucinationDetected ? 'var(--danger)' : 'var(--success)') : 'var(--text-muted)'}">
                        ${d ? (d.evalResult.hallucinationDetected ? '0% (Hallucinated)' : '100% (Clean)') : 'Not evaluated'}
                      </strong>
                    </div>
                  </div>
                </div>
              ` : ''}

            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (tab === 'about') {
    return `
      <div style="max-width: 900px;">
        <div class="hero-banner">
          <h3>Academic Project Documentation</h3>
          <p>Probe Bench — Retrieval-Augmented Generation (RAG) & Hugging Face Model Evaluation Platform</p>
          <div style="font-weight: 700; font-size: 0.95rem; color: #818cf8; margin-top: 12px; display: flex; align-items: center; gap: 8px; background: rgba(129, 140, 248, 0.15); padding: 6px 14px; border-radius: var(--radius-sm); border: 1px solid rgba(129, 140, 248, 0.3); width: fit-content;">
            <span>👨‍💻</span> Made by Divyanand
          </div>
        </div>

        <div class="comparison-card">
          <h4 style="margin-bottom: 12px;">1. Project Objective</h4>
          <p style="font-size: 0.9rem; color: var(--text-muted); line-height: 1.6; margin-bottom: 20px;">
            This application provides a controlled, fair academic environment to benchmark Hugging Face Language Models using a standardized synthetic clinic knowledge base and a ${N}-question test suite across four core evaluation metrics.
          </p>

          <h4 style="margin-bottom: 12px;">2. The 4 Evaluation Metrics</h4>
          <ul style="font-size: 0.9rem; color: var(--text-muted); line-height: 1.8; padding-left: 20px; margin-bottom: 20px;">
            <li><strong>Retrieval Accuracy:</strong> Evaluates whether the vector engine retrieves the exact expected knowledge entry (<code>Retrieved FAQ ID == Expected FAQ ID</code>).</li>
            <li><strong>Answer Correctness:</strong> Evaluates whether the generated response is factually consistent with the ground truth reference answer.</li>
            <li><strong>Answer Relevance:</strong> Verifies whether the generated answer directly addresses the intent of the question.</li>
            <li><strong>Hallucination Rate:</strong> Detects ungrounded or fabricated claims outside the retrieved context (lower is better!).</li>
          </ul>

          <h4 style="margin-bottom: 12px;">3. Academic Disclaimer</h4>
          <p style="font-size: 0.9rem; color: var(--text-muted); line-height: 1.6;">
            All medical clinic data, operating hours, addresses, and phone numbers in this project are 100% synthetic and created solely for academic evaluation.
          </p>
        </div>
      </div>
    `;
  }

  return `<div>Page under construction</div>`;
}

function renderAddQuestionModal() {
  if (!state.showAddQuestionModal) return '';

  const nextId = `TQ-${String(testQuestions.length + 1).padStart(3, '0')}`;

  return `
    <div class="modal-overlay" onclick="closeAddQuestionModal()">
      <div class="drawer" style="width: 550px;" onclick="event.stopPropagation()">
        <div class="drawer-header">
          <h3>➕ Add New Benchmark Question (${nextId})</h3>
          <button class="close-btn" onclick="closeAddQuestionModal()">×</button>
        </div>

        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 20px;">
          Add a custom benchmark question to test and expand evaluation metric N.
        </p>

        <div class="form-group">
          <label>Question Text *</label>
          <input type="text" id="new-q-text" class="form-control" placeholder="e.g. Can I request a copy of my X-ray reports online?">
        </div>

        <div class="form-group">
          <label>Test Category / Type</label>
          <select id="new-q-type" class="form-control">
            <option value="Direct Fact">Direct Fact</option>
            <option value="Paraphrase">Paraphrase</option>
            <option value="Conditional">Conditional</option>
            <option value="Negative/Boundary">Negative/Boundary</option>
            <option value="Multi-Detail">Multi-Detail</option>
            <option value="Out-of-Scope">Out-of-Scope</option>
            <option value="Hallucination Test">Hallucination Test</option>
          </select>
        </div>

        <div class="form-group">
          <label>Target / Expected FAQ Entry</label>
          <select id="new-q-faq" class="form-control">
            ${clinicFaqs.map(f => `<option value="${f.id}">${f.id} — ${f.topic} (${f.question.substring(0, 40)}...)</option>`).join('')}
          </select>
        </div>

        <div class="form-group">
          <label>Expected Ground Truth Answer *</label>
          <textarea id="new-q-ans" class="form-control" rows="3" placeholder="e.g. Digital copies can be downloaded from the patient portal within 24 hours."></textarea>
        </div>

        <div style="display: flex; gap: 12px; margin-top: 24px;">
          <button class="btn btn-primary" onclick="saveNewQuestion()">💾 Save Benchmark Question</button>
          <button class="btn btn-secondary" onclick="closeAddQuestionModal()">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderQuestionPipelineCard(item, idx) {
  const q = item.question;
  const isExpanded = !!state.expandedCards[q.id];
  const step = item.currentStep;

  let statusBadgeClass = 'warning';
  let statusText = '○ Waiting';
  if (item.status === 'completed') {
    statusBadgeClass = 'success';
    statusText = '✓ Completed';
  } else if (item.status === 'processing') {
    statusBadgeClass = 'info';
    statusText = '● Processing...';
  }

  return `
    <div class="question-pipeline-card">
      <!-- Card Summary Header -->
      <div class="card-summary-header" onclick="toggleCard('${q.id}')">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-weight: 800; font-size: 1rem; color: var(--primary);">Q${idx + 1}</span>
          <div>
            <h4 style="font-size: 0.95rem; font-weight: 700; color: var(--text-main);">${q.question}</h4>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${q.test_type} | Target: ${q.expected_faq_id}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 16px;">
          <span class="badge ${statusBadgeClass}">${statusText}</span>
          <span style="font-size: 1.2rem; color: var(--text-muted);">${isExpanded ? '▲' : '▼'}</span>
        </div>
      </div>

      ${isExpanded ? `
        <div style="padding: 24px; border-top: 1px solid var(--border); background: #ffffff;">
          <!-- Visual RAG Stepper Line -->
          <div class="pipeline-stepper">
            ${renderStepNode("1. Question", step >= 1, step === 1)}
            <div class="pipeline-connector ${step > 1 ? 'completed' : step === 1 ? 'active' : ''}"></div>
            ${renderStepNode("2. Retrieval", step >= 2, step === 2)}
            <div class="pipeline-connector ${step > 2 ? 'completed' : step === 2 ? 'active' : ''}"></div>
            ${renderStepNode("3. Context", step >= 3, step === 3)}
            <div class="pipeline-connector ${step > 3 ? 'completed' : step === 3 ? 'active' : ''}"></div>
            ${renderStepNode("4. Prompt", step >= 4, step === 4)}
            <div class="pipeline-connector ${step > 4 ? 'completed' : step === 4 ? 'active' : ''}"></div>
            ${renderStepNode("5. LLM Model", step >= 5, step === 5)}
            <div class="pipeline-connector ${step > 5 ? 'completed' : step === 5 ? 'active' : ''}"></div>
            ${renderStepNode("6. Answer", step >= 6, step === 6)}
            <div class="pipeline-connector ${step > 6 ? 'completed' : step === 6 ? 'active' : ''}"></div>
            ${renderStepNode("7. Evaluation", step >= 7, step === 7)}
          </div>

          <!-- Step 1: User Question -->
          <div class="rag-step-box">
            <div class="rag-step-title">📥 STEP 1 — USER QUESTION (INPUT)</div>
            <p style="font-size: 1rem; font-weight: 700; color: var(--text-main);">"${q.question}"</p>
          </div>

          <!-- Step 2: Retrieval -->
          ${item.retrievedFaq ? `
            <div class="rag-step-box">
              <div class="rag-step-title">🔍 STEP 2 — SEMANTIC RETRIEVAL (TF-IDF VECTOR ENGINE)</div>
              <div style="display: flex; justify-content: space-between; align-items: center; background: #ffffff; padding: 12px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                <div>
                  <strong style="color: var(--primary);">${item.retrievedFaq.id}</strong> — ${item.retrievedFaq.topic}
                  <div style="font-size: 0.8rem; color: var(--text-muted);">${item.retrievedFaq.question}</div>
                </div>
                <span class="badge info">Cosine Similarity: ${item.similarityScore}</span>
              </div>
            </div>
          ` : ''}

          <!-- Step 3: Retrieved Context -->
          ${item.retrievedFaq ? `
            <div class="rag-step-box">
              <div class="rag-step-title">📄 STEP 3 — RETRIEVED CONTEXT (PASSED TO LLM)</div>
              <p style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 8px;">This is the information retrieved from the knowledge base and provided to the model.</p>
              <div style="background: #f1f5f9; padding: 12px 16px; border-radius: var(--radius-sm); font-size: 0.9rem; border-left: 4px solid var(--primary);">
                "${item.retrievedFaq.context}"
              </div>
            </div>
          ` : ''}

          <!-- Step 4: Prompt Construction -->
          ${item.promptText ? `
            <div class="rag-step-box">
              <div class="rag-step-title">⚙️ STEP 4 — PROMPT CONSTRUCTION (GROUNDED SYSTEM PROMPT)</div>
              <div class="code-prompt-panel">${item.promptText}</div>
            </div>
          ` : ''}

          <!-- Step 5 & 6: Selected Model & Generated Answer -->
          ${item.modelA && item.modelB ? `
            <div class="rag-step-box">
              <div class="rag-step-title">🤖 STEP 5 & 6 — MODEL GENERATIONS</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div style="background: #eef2ff; padding: 14px; border-radius: var(--radius-md); border: 1px solid #c7d2fe;">
                  <h5 style="color: var(--primary); margin-bottom: 6px;">Model A: ${state.modelA.name}</h5>
                  <p style="font-size: 0.85rem; color: var(--text-main); font-weight: 500;">"${item.modelA.generatedAnswer}"</p>
                </div>
                <div style="background: #fae8ff; padding: 14px; border-radius: var(--radius-md); border: 1px solid #f5d0fe;">
                  <h5 style="color: #c026d3; margin-bottom: 6px;">Model B: ${state.modelB.name}</h5>
                  <p style="font-size: 0.85rem; color: var(--text-main); font-weight: 500;">"${item.modelB.generatedAnswer}"</p>
                </div>
              </div>
            </div>
          ` : ''}

          <!-- Step 7: Evaluation Breakdown -->
          ${item.modelA && item.modelB ? `
            <div class="rag-step-box" style="margin-bottom: 0;">
              <div class="rag-step-title">📊 STEP 7 — METRIC EVALUATION BREAKDOWN</div>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div style="background: #ffffff; padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                  <strong style="font-size: 0.85rem; color: var(--primary);">Model A Evaluation:</strong>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;">
                    <span class="badge ${item.modelA.retrievalCorrect ? 'success' : 'danger'}">Retrieval: ${item.modelA.retrievalCorrect ? '✓ Correct' : '✗ Incorrect'}</span>
                    <span class="badge ${item.modelA.answerCorrect ? 'success' : 'danger'}">Correctness: ${item.modelA.answerCorrect ? '✓ Correct' : '✗ Incorrect'}</span>
                    <span class="badge ${item.modelA.answerRelevance ? 'success' : 'danger'}">Relevance: ${item.modelA.answerRelevance ? '✓ Relevant' : '✗ Off-topic'}</span>
                    <span class="badge ${item.modelA.hallucinationDetected ? 'danger' : 'success'}">Hallucination: ${item.modelA.hallucinationDetected ? '⚠️ Detected' : '✓ None'}</span>
                  </div>
                </div>

                <div style="background: #ffffff; padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
                  <strong style="font-size: 0.85rem; color: #c026d3;">Model B Evaluation:</strong>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px;">
                    <span class="badge ${item.modelB.retrievalCorrect ? 'success' : 'danger'}">Retrieval: ${item.modelB.retrievalCorrect ? '✓ Correct' : '✗ Incorrect'}</span>
                    <span class="badge ${item.modelB.answerCorrect ? 'success' : 'danger'}">Correctness: ${item.modelB.answerCorrect ? '✓ Correct' : '✗ Incorrect'}</span>
                    <span class="badge ${item.modelB.answerRelevance ? 'success' : 'danger'}">Relevance: ${item.modelB.answerRelevance ? '✓ Relevant' : '✗ Off-topic'}</span>
                    <span class="badge ${item.modelB.hallucinationDetected ? 'danger' : 'success'}">Hallucination: ${item.modelB.hallucinationDetected ? '⚠️ Detected' : '✓ None'}</span>
                  </div>
                </div>
              </div>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderPieChartSVG(pct, color = '#4f46e5', label = '') {
  const radius = 32;
  const circumference = 2 * Math.PI * radius; // ~201.06
  const strokeDash = Math.max(0, Math.min(circumference, (pct / 100) * circumference));
  const strokeGap = circumference - strokeDash;

  return `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; width: 120px;">
      <div style="position: relative; width: 76px; height: 76px; display: flex; align-items: center; justify-content: center;">
        <svg width="76" height="76" viewBox="0 0 80 80" style="transform: rotate(-90deg);">
          <circle cx="40" cy="40" r="${radius}" fill="transparent" stroke="#e2e8f0" stroke-width="10" />
          <circle cx="40" cy="40" r="${radius}" fill="transparent" stroke="${color}" stroke-width="10"
            stroke-dasharray="${strokeDash} ${strokeGap}" stroke-linecap="round" />
        </svg>
        <span style="position: absolute; font-size: 0.95rem; font-weight: 800; color: var(--text-main);">${pct}%</span>
      </div>
      <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-muted); margin-top: 6px; text-align: center;">${label}</span>
    </div>
  `;
}

function renderStepNode(label, isCompleted, isActive) {
  let cls = '';
  let icon = '○';
  if (isCompleted) {
    cls = 'completed';
    icon = '✓';
  } else if (isActive) {
    cls = 'active';
    icon = '●';
  }

  return `
    <div class="pipeline-step-node ${cls}">
      <div class="pipeline-step-icon">${icon}</div>
      <div class="pipeline-step-label">${label}</div>
    </div>
  `;
}

function renderChartRow(title, valA, valB, isLowerBetter = false) {
  return `
    <div class="chart-bar-row">
      <div class="chart-label">
        <span>${title}</span>
        <span>Model A: ${valA}% | Model B: ${valB}%</span>
      </div>
      <div class="bars-wrapper">
        <div class="bar-track">
          <div class="bar-fill model-a" style="width: ${Math.max(5, valA)}%;">${valA}%</div>
        </div>
        <div class="bar-track">
          <div class="bar-fill model-b" style="width: ${Math.max(5, valB)}%;">${valB}%</div>
        </div>
      </div>
    </div>
  `;
}

function renderDetailDrawer() {
  const item = state.selectedDetailItem;
  if (!item) return '';

  return `
    <div class="modal-overlay" onclick="closeDetailDrawer()">
      <div class="drawer" onclick="event.stopPropagation()">
        <div class="drawer-header">
          <h3>Question Inspection (${item.question.id})</h3>
          <button class="close-btn" onclick="closeDetailDrawer()">×</button>
        </div>

        <div style="margin-bottom: 20px;">
          <h4 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">User Question</h4>
          <p style="font-size: 1.1rem; font-weight: 700;">${item.question.question}</p>
        </div>

        <div style="margin-bottom: 20px; background: #f8fafc; padding: 16px; border-radius: var(--radius-md); border: 1px solid var(--border);">
          <h4 style="font-size: 0.85rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px;">Expected Ground Truth Reference Answer</h4>
          <p style="font-size: 0.95rem;">${item.question.expected_answer}</p>
        </div>

        <div style="margin-bottom: 24px; background: #e0f2fe; padding: 16px; border-radius: var(--radius-md); border: 1px solid #bae6fd;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
            <strong style="color: #0369a1;">Retrieved Context (${item.retrievedFaq.id} - ${item.retrievedFaq.topic})</strong>
            <span class="badge info">Similarity: ${item.similarityScore}</span>
          </div>
          <p style="font-size: 0.9rem; color: #0c4a6e;">${item.retrievedFaq.context}</p>
        </div>

        <!-- Model Responses Side by Side -->
        <div style="display: flex; flex-direction: column; gap: 20px;">
          <!-- Model A -->
          <div style="border: 1px solid var(--border); padding: 16px; border-radius: var(--radius-md);">
            <h4 style="color: var(--primary); margin-bottom: 8px;">Model A: ${state.modelA.name}</h4>
            <p style="font-size: 0.9rem; background: #f8fafc; padding: 12px; border-radius: var(--radius-sm); margin-bottom: 12px;">"${item.modelA.generatedAnswer}"</p>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <span class="badge ${item.modelA.retrievalCorrect ? 'success' : 'danger'}">Retrieval: ${item.modelA.retrievalCorrect ? 'Correct' : 'Incorrect'}</span>
              <span class="badge ${item.modelA.answerCorrect ? 'success' : 'danger'}">Correctness: ${item.modelA.answerCorrect ? 'Correct' : 'Incorrect'}</span>
              <span class="badge ${item.modelA.answerRelevance ? 'success' : 'danger'}">Relevance: ${item.modelA.answerRelevance ? 'Relevant' : 'Not Relevant'}</span>
              <span class="badge ${item.modelA.hallucinationDetected ? 'danger' : 'success'}">Hallucination: ${item.modelA.hallucinationDetected ? 'Detected' : 'None'}</span>
            </div>
          </div>

          <!-- Model B -->
          <div style="border: 1px solid var(--border); padding: 16px; border-radius: var(--radius-md);">
            <h4 style="color: #c026d3; margin-bottom: 8px;">Model B: ${state.modelB.name}</h4>
            <p style="font-size: 0.9rem; background: #f8fafc; padding: 12px; border-radius: var(--radius-sm); margin-bottom: 12px;">"${item.modelB.generatedAnswer}"</p>
            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <span class="badge ${item.modelB.retrievalCorrect ? 'success' : 'danger'}">Retrieval: ${item.modelB.retrievalCorrect ? 'Correct' : 'Incorrect'}</span>
              <span class="badge ${item.modelB.answerCorrect ? 'success' : 'danger'}">Correctness: ${item.modelB.answerCorrect ? 'Correct' : 'Incorrect'}</span>
              <span class="badge ${item.modelB.answerRelevance ? 'success' : 'danger'}">Relevance: ${item.modelB.answerRelevance ? 'Relevant' : 'Not Relevant'}</span>
              <span class="badge ${item.modelB.hallucinationDetected ? 'danger' : 'success'}">Hallucination: ${item.modelB.hallucinationDetected ? 'Detected' : 'None'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Start application
init();
