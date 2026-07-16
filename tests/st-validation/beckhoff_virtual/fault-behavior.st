TEST 'beckhoff virtual injected motion fault'
VAR
    axis : AXIS_REF;
    move : MC_MoveAbsolute;
END_VAR

axis.ADS := 2002;
move(Axis := axis, Execute := TRUE, Position := 99.0);
ASSERT_TRUE(move.Busy);
move(Axis := axis, Execute := TRUE, Position := 99.0);
ASSERT_FALSE(move.Busy);
ASSERT_FALSE(move.Done);
ASSERT_TRUE(move.Error);
ASSERT_EQ(move.ErrorID, 16#F0000005);
ASSERT_EQ(axis.Position, 7.0);
END_TEST
