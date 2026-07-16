TEST 'beckhoff virtual motion lifecycle'
VAR
    axis : AXIS_REF;
    power : MC_Power;
    move : MC_MoveAbsolute;
END_VAR

axis.ADS := 1001;

power(Axis := axis, Enable := TRUE);
ASSERT_FALSE(power.Status);
power(Axis := axis, Enable := TRUE);
ASSERT_TRUE(power.Status);
ASSERT_TRUE(axis.Enabled);

move(Axis := axis, Execute := TRUE, Position := 42.5, Velocity := 3.0);
ASSERT_TRUE(move.Busy);
ASSERT_FALSE(move.Done);
move(Axis := axis, Execute := TRUE, Position := 42.5, Velocity := 3.0);
ASSERT_FALSE(move.Busy);
ASSERT_TRUE(move.Done);
ASSERT_EQ(axis.Position, 42.5);
ASSERT_EQ(axis.Velocity, 3.0);
END_TEST

TEST 'beckhoff virtual sandbox file lifecycle'
VAR
    fileOpen : FB_FileOpen;
    fileWrite : FB_FileWrite;
    fileRead : FB_FileRead;
END_VAR

fileOpen(sPathName := 'C:\virtual\input.txt', bExecute := TRUE);
ASSERT_TRUE(fileOpen.bBusy);
fileOpen(sPathName := 'C:\virtual\input.txt', bExecute := TRUE);
ASSERT_FALSE(fileOpen.bBusy);
ASSERT_FALSE(fileOpen.bError);
ASSERT_TRUE(fileOpen.hFile > 0);

fileWrite(hFile := fileOpen.hFile, cbWriteLen := 5, bExecute := TRUE);
ASSERT_TRUE(fileWrite.bBusy);
fileWrite(hFile := fileOpen.hFile, cbWriteLen := 5, bExecute := TRUE);
ASSERT_FALSE(fileWrite.bError);
ASSERT_EQ(fileWrite.cbWrite, 5);

fileRead(hFile := fileOpen.hFile, cbReadLen := 5, bExecute := TRUE);
ASSERT_TRUE(fileRead.bBusy);
fileRead(hFile := fileOpen.hFile, cbReadLen := 5, bExecute := TRUE);
ASSERT_FALSE(fileRead.bError);
ASSERT_EQ(fileRead.cbRead, 5);
ASSERT_TRUE(fileRead.bEOF);
END_TEST
