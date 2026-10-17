"""Phase 3 of the Effector port — blueprints: pre-built goal templates for common
enterprise workflows (LinkedIn Easy Apply, B2B lead enrichment, invoice extraction),
each driving react_loop with a crafted goal rather than a hand-written step list.

Founder decision (stage43, 2026-08-23): port every blueprint in full AND back their
persistence with nanoagent's existing skill system (save_skill/skill_ledger/
skill_search) rather than a bespoke playbook store — both, not either/or. See
runner.py for where a successful run gets offered to save_skill.
"""
