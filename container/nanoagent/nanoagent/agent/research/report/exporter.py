import os
import logging
from typing import List
from .types import PaperDraft

class ExportPipeline:
    """
    Converts paper drafts into multiple professional formats.
    """
    def __init__(self):
        self.logger = logging.getLogger(__name__)

    def export_markdown(self, draft: PaperDraft, output_dir: str) -> str:
        """
        Exports the draft to a Markdown file.
        """
        os.makedirs(output_dir, exist_ok=True)
        filename = os.path.join(output_dir, "paper.md")
        
        content = f"# {draft.title}\n\n"
        content += f"**Version**: {draft.version}\n\n"
        content += f"## Abstract\n{draft.abstract}\n\n"
        
        for section in draft.sections:
            content += f"## {section.heading}\n{section.content}\n\n"
            
        with open(filename, "w", encoding="utf-8") as f:
            f.write(content)
            
        self.logger.info(f"Markdown exported to: {filename}")
        return filename

    def export_latex(self, draft: PaperDraft, output_dir: str, template: str = "generic") -> str:
        """
        Exports the draft to a LaTeX file.
        """
        os.makedirs(output_dir, exist_ok=True)
        filename = os.path.join(output_dir, "paper.tex")
        
        # Simple generic LaTeX template
        latex_content = [
            r"\documentclass{article}",
            r"\usepackage[utf8]{inputenc}",
            f"\\title{{{draft.title}}}",
            r"\author{nanocrew Autonomous Researcher Agent}",
            r"\date{\today}",
            r"\begin{document}",
            r"\maketitle",
            r"\begin{abstract}",
            draft.abstract,
            r"\end{abstract}",
            ""
        ]
        
        for section in draft.sections:
            latex_content.append(f"\\section{{{section.heading}}}")
            latex_content.append(section.content)
            latex_content.append("")
            
        latex_content.append(r"\end{document}")
        
        full_latex = "\n".join(latex_content)
        with open(filename, "w", encoding="utf-8") as f:
            f.write(full_latex)
            
        self.logger.info(f"LaTeX exported to: {filename}")
        return filename

    def export_bibtex(self, citations: List[str], output_dir: str) -> str:
        """
        Exports citations to a BibTeX file.
        """
        os.makedirs(output_dir, exist_ok=True)
        filename = os.path.join(output_dir, "references.bib")
        
        bib_content = ""
        for i, cite in enumerate(citations):
            # Very basic BibTeX entry generation
            cite_id = f"ref{i+1}"
            bib_content += f"@article{{{cite_id},\n  title = {{{cite}}},\n  author = {{Unknown}},\n  year = {{2025}}\n}}\n\n"
            
        with open(filename, "w", encoding="utf-8") as f:
            f.write(bib_content)
            
        self.logger.info(f"BibTeX exported to: {filename}")
        return filename
