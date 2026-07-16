PROGRAM BeckhoffVirtualSmoke
VAR
  adsReader : FB_ReadAdsSymByName;
  motionPower : MC_Power;
  allocator : FB_DynMem_Manager;
  axis : AXIS_REF;
  allocated : PVOID;
  allocatedSize : UDINT;
  errorText : STRING;
END_VAR

adsReader(bRead := TRUE);
motionPower(Axis := axis, Enable := TRUE);
allocated := allocator.Alloc(nSize := 16, bReset := TRUE);
allocatedSize := allocator.nAllocatedSize;
errorText := F_IolGetAdsErrorTxt(nAdsErr := 0);
END_PROGRAM
