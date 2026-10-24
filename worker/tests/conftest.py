import sys
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER))
sys.path.insert(0, str(WORKER / "lhm_stages"))
