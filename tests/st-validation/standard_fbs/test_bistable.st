TEST 'SR set-dominant with four input combos'
  VAR sr : SR; q_set, q_both, q_reset, q_neither : BOOL; END_VAR
  sr(S1 := TRUE, R := FALSE);
  q_set := sr.Q1;
  sr(S1 := TRUE, R := TRUE);
  q_both := sr.Q1;
  sr(S1 := FALSE, R := TRUE);
  q_reset := sr.Q1;
  sr(S1 := FALSE, R := FALSE);
  q_neither := sr.Q1;
  ASSERT_TRUE(q_set);
  ASSERT_TRUE(q_both);
  ASSERT_FALSE(q_reset);
  ASSERT_FALSE(q_neither);
END_TEST

TEST 'SR state persistence when both FALSE'
  VAR sr : SR; q_after_set, q_persist1, q_persist2 : BOOL; END_VAR
  sr(S1 := TRUE, R := FALSE);
  q_after_set := sr.Q1;
  sr(S1 := FALSE, R := FALSE);
  q_persist1 := sr.Q1;
  sr(S1 := FALSE, R := FALSE);
  q_persist2 := sr.Q1;
  ASSERT_TRUE(q_after_set);
  ASSERT_TRUE(q_persist1);
  ASSERT_TRUE(q_persist2);
END_TEST

TEST 'RS reset-dominant with four input combos'
  VAR rs : RS; q_set, q_both, q_reset, q_neither : BOOL; END_VAR
  rs(S := TRUE, R1 := FALSE);
  q_set := rs.Q1;
  rs(S := TRUE, R1 := TRUE);
  q_both := rs.Q1;
  rs(S := TRUE, R1 := FALSE);
  rs(S := FALSE, R1 := TRUE);
  q_reset := rs.Q1;
  rs(S := FALSE, R1 := FALSE);
  q_neither := rs.Q1;
  ASSERT_TRUE(q_set);
  ASSERT_FALSE(q_both);
  ASSERT_FALSE(q_reset);
  ASSERT_FALSE(q_neither);
END_TEST

TEST 'TwinCAT SR canonical SET1 RESET interface'
  VAR sr : SR; q_set, q_reset : BOOL; END_VAR
  sr(SET1 := TRUE, RESET := TRUE);
  q_set := sr.Q1;
  sr(SET1 := FALSE, RESET := TRUE);
  q_reset := sr.Q1;
  ASSERT_TRUE(q_set);
  ASSERT_FALSE(q_reset);
END_TEST

TEST 'TwinCAT RS canonical SET RESET1 interface'
  VAR rs : RS; q_set, q_reset : BOOL; END_VAR
  rs(SET := TRUE, RESET1 := FALSE);
  q_set := rs.Q1;
  rs(SET := TRUE, RESET1 := TRUE);
  q_reset := rs.Q1;
  ASSERT_TRUE(q_set);
  ASSERT_FALSE(q_reset);
END_TEST
