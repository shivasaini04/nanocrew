import asyncio
import logging
from typing import List, Dict, Any, Optional
from .arxiv import PaperMetadata, ArxivClient
from .semantic_scholar import SemanticScholarClient

class SearchStrategy:
    """
    Orchestrates multiple literature sources and applies LLM-powered strategies
    for query expansion and relevance ranking.
    """
    def __init__(self, subagent_manager: Any):
        self.subagent_manager = subagent_manager
        self.logger = logging.getLogger(__name__)

    async def generate_queries(self, goal: str, domain: str = "computer science") -> List[str]:
        """
        Uses an LLM to expand a research goal into a list of specific search queries.
        """
        self.logger.info(f"Generating expanded queries for goal: {goal}")
        
        # Placeholder for LLM call
        # prompt = f"Given the research goal '{goal}' in the domain '{domain}', generate 5 diverse academic search queries."
        # response = await self.subagent_manager.call_llm(prompt)
        # return parse_queries(response)
        
        # Default fallback: use the goal itself as a query
        return [goal]

    def deduplicate(self, papers: List[PaperMetadata]) -> List[PaperMetadata]:
        """
        Merges duplicate papers based on arXiv ID or DOI.
        """
        seen_ids = set()
        unique_papers = []
        
        for paper in papers:
            # Generate a unique identifier for dedupe
            uid = None
            if paper.arxiv_id:
                uid = f"arxiv:{paper.arxiv_id}"
            elif hasattr(paper, 'doi') and paper.doi:
                uid = f"doi:{paper.doi}"
            else:
                uid = f"title:{paper.title.lower().strip()}"
            
            if uid not in seen_ids:
                seen_ids.add(uid)
                unique_papers.append(paper)
            else:
                self.logger.debug(f"Deduplicated paper: {paper.title}")
                
        return unique_papers

    async def rank_by_relevance(self, papers: List[PaperMetadata], goal: str) -> List[PaperMetadata]:
        """
        Uses an LLM to score papers (0-10) based on relevance to the goal and sorts them.
        """
        if not papers:
            return []
            
        self.logger.info(f"Ranking {len(papers)} papers by relevance to: {goal}")
        
        # Placeholder for LLM ranking logic:
        # For each paper, get a score.
        # scored_papers = []
        # for paper in papers:
        #    score = await self.subagent_manager.get_relevance_score(paper.abstract, goal)
        #    scored_papers.append((score, paper))
        # scored_papers.sort(key=lambda x: x[0], reverse=True)
        # return [p[1] for p in scored_papers]
        
        # Default: return as-is (no ranking performed yet)
        return papers

    async def execute_multi_source_search(
        self, 
        goal: str, 
        arxiv_client: ArxivClient, 
        s2_client: SemanticScholarClient,
        max_results_per_source: int = 20
    ) -> List[PaperMetadata]:
        """
        Full orchestration of literature search: expansion, fetching, merging, ranking.
        """
        # 1. Expand queries
        queries = await self.generate_queries(goal)
        
        all_results = []
        
        # 2. Fetch from sources
        for query in queries:
            self.logger.info(f"Searching for query: {query}")
            
            # Parallel fetch from sources
            res_arxiv, res_s2 = await asyncio.gather(
                arxiv_client.search(query, max_results=max_results_per_source),
                s2_client.search(query, limit=max_results_per_source)
            )
            
            all_results.extend(res_arxiv)
            all_results.extend(res_s2)
            
        # 3. Deduplicate
        unique_results = self.deduplicate(all_results)
        
        # 4. Rank
        ranked_results = await self.rank_by_relevance(unique_results, goal)
        
        return ranked_results
