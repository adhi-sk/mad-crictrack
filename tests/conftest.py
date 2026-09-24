# tests/conftest.py
import sys
from pathlib import Path

# Insert repository root directory into sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))