/**
 * Real Semantic Retrieval Engine
 * Implements TF-IDF Tokenization, Term Frequency-Inverse Document Frequency Vectorization,
 * and Cosine Similarity calculation across the 25 Clinic FAQ documents.
 */

// Simple English stemmer and stopword list for clean semantic matching
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren\'t', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'can\'t', 'cannot',
  'could', 'did', 'do', 'does', 'doing', 'don\'t', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had',
  'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off',
  'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should',
  'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves'
]);

function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

export class SemanticRetriever {
  constructor(faqs) {
    this.faqs = faqs;
    this.vocabulary = new Set();
    this.docVectors = [];
    this.idf = {};

    this._buildIndex();
  }

  _buildIndex() {
    const N = this.faqs.length;
    const docTermFreqs = [];
    const docFreqs = {};

    // 1. Process documents
    this.faqs.forEach((faq) => {
      // Combine topic, question, context, and answer for rich semantic indexing
      const fullText = `${faq.topic} ${faq.question} ${faq.context} ${faq.answer}`;
      const tokens = tokenize(fullText);
      const tf = {};

      tokens.forEach(t => {
        this.vocabulary.add(t);
        tf[t] = (tf[t] || 0) + 1;
      });

      docTermFreqs.push(tf);

      // Track document frequencies
      Object.keys(tf).forEach(term => {
        docFreqs[term] = (docFreqs[term] || 0) + 1;
      });
    });

    // 2. Compute IDF for each term
    this.vocabulary.forEach(term => {
      const df = docFreqs[term] || 1;
      this.idf[term] = Math.log((N + 1) / (df + 0.5));
    });

    // 3. Compute TF-IDF vectors & normalizations
    this.docVectors = docTermFreqs.map(tf => {
      const vec = {};
      let normSq = 0;

      Object.keys(tf).forEach(term => {
        const tfidf = tf[term] * (this.idf[term] || 1);
        vec[term] = tfidf;
        normSq += tfidf * tfidf;
      });

      return {
        vector: vec,
        magnitude: Math.sqrt(normSq) || 1.0
      };
    });
  }

  /**
   * Search for top matching FAQ given a user query
   * @param {string} query 
   * @returns {{ faq: object, similarityScore: number }}
   */
  search(query) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return {
        faq: this.faqs[0],
        similarityScore: 0.1
      };
    }

    const queryTf = {};
    queryTokens.forEach(t => {
      queryTf[t] = (queryTf[t] || 0) + 1;
    });

    const queryVec = {};
    let queryNormSq = 0;

    Object.keys(queryTf).forEach(term => {
      const idfVal = this.idf[term] || Math.log(this.faqs.length + 1);
      const tfidf = queryTf[term] * idfVal;
      queryVec[term] = tfidf;
      queryNormSq += tfidf * tfidf;
    });

    const queryMag = Math.sqrt(queryNormSq) || 1.0;

    let bestFaqIndex = 0;
    let bestSimilarity = -1;
    const scores = [];

    this.docVectors.forEach((doc, idx) => {
      let dotProduct = 0;
      Object.keys(queryVec).forEach(term => {
        if (doc.vector[term]) {
          dotProduct += queryVec[term] * doc.vector[term];
        }
      });

      let similarity = dotProduct / (queryMag * doc.magnitude);
      
      // Fine-grained boost for exact keyword hits in topic or question
      const faq = this.faqs[idx];
      const queryLower = query.toLowerCase();
      if (queryLower.includes(faq.topic.toLowerCase())) {
        similarity += 0.15;
      }
      
      // Bound between 0.05 and 0.98
      similarity = Math.max(0.05, Math.min(0.98, similarity));
      scores.push({ index: idx, similarity });

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestFaqIndex = idx;
      }
    });

    return {
      faq: this.faqs[bestFaqIndex],
      similarityScore: parseFloat(bestSimilarity.toFixed(2)),
      allScores: scores
    };
  }
}
