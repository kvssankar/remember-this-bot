/**
 * Search Utility - Custom Similarity Matrix Implementation
 */
const stringSimilarity = require("string-similarity");

const STOP_WORDS = new Set([
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did',
  'a', 'an', 'the', 'and', 'but', 'or', 'as', 'if', 'of', 'at', 'by', 'for', 'with', 'about', 'to', 'in', 'on',
  'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their'
]);

const searchUtil = {
  /**
   * Tokenize string and remove stopwords/verbs
   */
  tokenize(text) {
    if (!text) return [];
    return text
      .toLowerCase()
      .split(/[\s,.]+/)
      .filter(word => word.length > 1 && !STOP_WORDS.has(word));
  },

  /**
   * Custom Matrix Similarity Search
   * 1. Tokenize query and item
   * 2. For each query word, find best match in item words
   * 3. If similarity >= 0.8, count as a match (1 in matrix)
   * 4. Sum matches for total score
   */
  rankItems(query, items, topN = 5) {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) return items.slice(0, topN);

    const scoredItems = items.map(item => {
      const itemText = `${item.title} ${item.content} ${item.category || ''}`;
      const itemTokens = this.tokenize(itemText);
      
      if (itemTokens.length === 0) return { ...item, _searchScore: 0 };

      let totalMatchScore = 0;

      // Create Matrix logic: Query(X) vs Item(Y)
      for (const qToken of queryTokens) {
        let bestWordSimilarity = 0;
        
        for (const iToken of itemTokens) {
          // Use string-similarity (Dice's Coefficient) - ensuring lowercase
          const score = stringSimilarity.compareTwoStrings(qToken.toLowerCase(), iToken.toLowerCase());
          if (score > bestWordSimilarity) {
            bestWordSimilarity = score;
          }
        }

        // Apply threshold: any box >= 0.8 becomes 1, else 0
        if (bestWordSimilarity >= 0.8) {
          totalMatchScore += 1;
        }
      }

      return { ...item, _searchScore: totalMatchScore };
    });

    // Sort by score descending, then by timestamp (latest first) descending, and take top 10
    return scoredItems
      .filter(item => item._searchScore > 0)
      .sort((a, b) => {
        if (b._searchScore !== a._searchScore) {
          return b._searchScore - a._searchScore;
        }
        // Tie-breaker: Latest timestamp first
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      })
      .slice(0, topN);
  }
};

module.exports = searchUtil;
