import pandas as pd
COLS=['year','week','season_type','game_id','id_drive','drive_number','pos_team','def_pos_team','period','TimeSecsRem','adj_TimeSecsRem','down','distance','yards_to_goal','play_type','play_text','pos_score_diff_start','pos_team_score','def_pos_team_score','home_team_division','away_team_division','off_timeouts_rem_before','def_timeouts_rem_before','drive_result','drive_result_detailed','yards_gained','wp_before','wp_after','EPA','position_target','position_rush','home_team_pregame_elo','away_team_pregame_elo','home','away','home_team_id','away_team_id','start_date','game_play_number','passer_player_name','receiver_player_name','rusher_player_name','target_player','rush_player','pass','rush','sack','int','fumble_vec','completion','touchdown','penalty_flag','penalty_no_play','neutral_site','spread','home_team_conference','away_team_conference','conference_game']
def load(years=(2023,2024,2025)):
    out=[]
    for y in years:
        p=pd.read_parquet(f'C:/Users/pmcin/cfb-2min-drill/raw/pbp_{y}.parquet',columns=COLS)
        p=p[(p.home_team_division=='fbs')&(p.away_team_division=='fbs')]
        out.append(p)
    return pd.concat(out,ignore_index=True)
