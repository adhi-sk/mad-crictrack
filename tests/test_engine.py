import pytest
from backend.engine import ScoringEngine
from backend.models import Match, Team


def make_engine(overs: int = 2) -> ScoringEngine:
    match = Match(
        team_a=Team("Alpha"),
        team_b=Team("Beta"),
        overs_limit=overs,
    )
    engine = ScoringEngine(match)
    engine.start_innings(match.team_a, match.team_b)
    engine.set_openers("Striker1", "NonStriker1", "Bowler1")
    return engine


# ---------------- Runs and Batting Stats ----------------

def test_record_runs_and_batting_stats():
    engine = make_engine()
    engine.record_ball(runs=4)

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("Striker1")
    bowler = engine.match.team_b.get_player("Bowler1")

    assert inn.total_runs == 4
    assert inn.legal_balls_bowled == 1
    assert batter.runs == 4
    assert batter.fours == 1
    assert batter.balls_faced == 1
    assert bowler.balls_bowled == 1
    assert bowler.runs_conceded == 4


def test_six_runs_stats():
    engine = make_engine()
    engine.record_ball(runs=6)

    batter = engine.match.team_a.get_player("Striker1")
    assert batter.runs == 6
    assert batter.sixes == 1
    assert batter.balls_faced == 1
    # Boundaries do not swap ends
    assert engine.striker == "Striker1"
    assert engine.non_striker == "NonStriker1"


def test_five_runs_swaps_strike():
    engine = make_engine()
    engine.record_ball(runs=5)

    batter = engine.match.team_a.get_player("Striker1")
    assert batter.runs == 5
    assert batter.fours == 0
    # Odd runs physically run must swap strike
    assert engine.striker == "NonStriker1"
    assert engine.non_striker == "Striker1"


def test_odd_and_even_strike_rotation():
    engine = make_engine()
    # 1 run -> swap
    engine.record_ball(runs=1)
    assert engine.striker == "NonStriker1"
    assert engine.non_striker == "Striker1"

    # 2 runs -> keep strike
    engine.record_ball(runs=2)
    assert engine.striker == "NonStriker1"
    assert engine.non_striker == "Striker1"


# ---------------- Extras Handling ----------------

def test_wide_ball_rules():
    engine = make_engine()
    # Wide with 0 extra physical runs (1 penalty run)
    engine.record_ball(extra_type="wide", extra_runs=1)

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("Striker1")
    bowler = engine.match.team_b.get_player("Bowler1")

    assert inn.total_runs == 1
    assert inn.legal_balls_bowled == 0
    assert batter.balls_faced == 0
    assert bowler.balls_bowled == 0
    assert bowler.runs_conceded == 1
    # No strike rotation
    assert engine.striker == "Striker1"


def test_wide_with_odd_additional_runs_swaps_strike():
    engine = make_engine()
    # Wide + 1 run run by batters (total extra_runs = 2)
    engine.record_ball(extra_type="wide", extra_runs=2)

    assert engine.match.current_innings.total_runs == 2
    assert engine.striker == "NonStriker1"
    assert engine.non_striker == "Striker1"


def test_no_ball_rules():
    engine = make_engine()
    # No ball with 2 runs off the bat
    engine.record_ball(runs=2, extra_type="no_ball", extra_runs=1)

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("Striker1")
    bowler = engine.match.team_b.get_player("Bowler1")

    assert inn.total_runs == 3  # 2 off bat + 1 nb penalty
    assert inn.legal_balls_bowled == 0
    assert batter.balls_faced == 1  # counts as ball faced
    assert batter.runs == 2
    assert bowler.balls_bowled == 0
    assert bowler.runs_conceded == 3


def test_byes_do_not_debit_bowler():
    engine = make_engine()
    engine.record_ball(extra_type="bye", extra_runs=2)

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("Striker1")
    bowler = engine.match.team_b.get_player("Bowler1")

    assert inn.total_runs == 2
    assert inn.legal_balls_bowled == 1
    assert batter.balls_faced == 1
    assert batter.runs == 0  # not credited to batter
    assert bowler.balls_bowled == 1
    assert bowler.runs_conceded == 0  # NOT charged to bowler


def test_leg_byes_odd_runs_swaps_strike():
    engine = make_engine()
    engine.record_ball(extra_type="leg_bye", extra_runs=1)

    inn = engine.match.current_innings
    bowler = engine.match.team_b.get_player("Bowler1")

    assert inn.total_runs == 1
    assert bowler.runs_conceded == 0
    # 1 run physically run swaps strike
    assert engine.striker == "NonStriker1"
    assert engine.non_striker == "Striker1"


# ---------------- Wickets ----------------

def test_bowled_wicket():
    engine = make_engine()
    engine.record_ball(is_wicket=True, wicket_type="Bowled", player_out="Striker1")

    inn = engine.match.current_innings
    batter = engine.match.team_a.get_player("Striker1")
    bowler = engine.match.team_b.get_player("Bowler1")

    assert inn.wickets == 1
    assert batter.is_out is True
    assert batter.out_description == "Bowled b Bowler1"
    assert bowler.wickets == 1
    assert engine.striker is None  # vacated for next batter


def test_run_out_does_not_credit_bowler():
    engine = make_engine()
    engine.record_ball(is_wicket=True, wicket_type="run_out", player_out="NonStriker1")

    inn = engine.match.current_innings
    bowler = engine.match.team_b.get_player("Bowler1")
    non_striker = engine.match.team_a.get_player("NonStriker1")

    assert inn.wickets == 1
    assert bowler.wickets == 0  # Bowler does not get credit for run out
    assert non_striker.is_out is True
    assert engine.non_striker is None
    assert engine.striker == "Striker1"


# ---------------- Over Completion & Strike Swap ----------------

def test_over_completion_resets_bowler_and_swaps_strike():
    engine = make_engine()
    # 5 dot balls
    for _ in range(5):
        engine.record_ball(runs=0)
    assert engine.striker == "Striker1"

    # 6th ball is 0 runs -> end of over swaps strike
    engine.record_ball(runs=0)
    assert engine.striker == "NonStriker1"
    assert engine.non_striker == "Striker1"
    assert engine.bowler is None  # must select new bowler


def test_single_on_last_ball_retains_strike():
    engine = make_engine()
    for _ in range(5):
        engine.record_ball(runs=0)

    # 6th ball: 1 run (swaps strike for the single, then swaps again for over end)
    engine.record_ball(runs=1)
    assert engine.striker == "Striker1"
    assert engine.non_striker == "NonStriker1"


# ---------------- Innings & Match Results ----------------

def test_all_out_completes_innings():
    engine = make_engine(overs=10)
    inn = engine.match.current_innings
    
    # First 6 wickets in over 1 (Bowler1)
    for i in range(6):
        engine.record_ball(is_wicket=True, wicket_type="Bowled", player_out=f"Striker{i}")
        engine.new_batsman(f"Striker{i+1}", at_striker=True)
    
    # Over 1 ended, bowler is now None; assign a new bowler for Over 2
    assert engine.bowler is None
    engine.new_bowler("Bowler2")
    
    # Remaining 4 wickets in over 2 (Bowler2)
    for i in range(6, 10):
        engine.record_ball(is_wicket=True, wicket_type="Bowled", player_out=f"Striker{i}")
        if i < 9:
            engine.new_batsman(f"Striker{i+1}", at_striker=True)

    assert inn.wickets == 10
    assert inn.is_complete is True


def test_chase_completed_win_by_wickets():
    engine = make_engine(overs=2)
    engine.match.innings[0].is_complete = True
    
    # Second innings chasing target of 11
    engine.start_innings(engine.match.team_b, engine.match.team_a, target=11)
    engine.set_openers("Chaser1", "Chaser2", "BowlerA")

    engine.record_ball(runs=6)
    engine.record_ball(runs=6)  # 12 runs reached

    assert engine.match.innings[1].is_complete is True
    engine.determine_result()
    assert engine.match.result == "Beta won by 10 wicket(s)"


def test_defending_completed_win_by_runs():
    engine = make_engine(overs=1)
    # 1st innings: Alpha scores 10 runs
    engine.record_ball(runs=6)
    engine.record_ball(runs=4)
    for _ in range(4):
        engine.record_ball(runs=0)
    assert engine.match.innings[0].is_complete is True

    # 2nd innings: Beta chases 11, only scores 6 in 1 over
    engine.start_innings(engine.match.team_b, engine.match.team_a, target=11)
    engine.set_openers("Beta1", "Beta2", "BowlerA")
    engine.record_ball(runs=6)
    for _ in range(5):
        engine.record_ball(runs=0)

    assert engine.match.innings[1].is_complete is True
    engine.determine_result()
    assert engine.match.result == "Alpha won by 4 run(s)"
	