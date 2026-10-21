package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// secureStateDir replaces the inherited DACL with a protected one that grants
// only the current user and Administrators, then reads it back, because the
// state dir holds the node key and a silently weaker ACL must stop startup.
func secureStateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode().Type() != fs.ModeDir {
		return fmt.Errorf("%s is not a directory (mode %v)", dir, fi.Mode())
	}

	token, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return err
	}
	user := token.User.Sid
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return err
	}
	var pinner runtime.Pinner
	defer pinner.Unpin()
	pinner.Pin(user)
	pinner.Pin(admins)

	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{
		fullControl(user, windows.TRUSTEE_IS_USER),
		fullControl(admins, windows.TRUSTEE_IS_WELL_KNOWN_GROUP),
	}, nil)
	if err != nil {
		return err
	}
	const info = windows.OWNER_SECURITY_INFORMATION |
		windows.DACL_SECURITY_INFORMATION |
		windows.PROTECTED_DACL_SECURITY_INFORMATION
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, info, user, nil, acl, nil); err != nil {
		return err
	}
	return verifyDACL(dir, user, admins)
}

func fullControl(sid *windows.SID, kind windows.TRUSTEE_TYPE) windows.EXPLICIT_ACCESS {
	return windows.EXPLICIT_ACCESS{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.SET_ACCESS,
		Inheritance:       windows.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  kind,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}
}

func verifyDACL(dir string, user, admins *windows.SID) error {
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		return fmt.Errorf("%s still inherits its parent's ACL", dir)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if !owner.Equals(user) {
		return fmt.Errorf("%s is not owned by the current user", dir)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if dacl == nil {
		return errors.New("state dir has a NULL DACL")
	}
	userGranted := false
	for i := range uint32(dacl.AceCount) {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return fmt.Errorf("%s has an unexpected ACE type %d", dir, ace.Header.AceType)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		switch {
		case sid.Equals(user):
			userGranted = true
		case sid.Equals(admins):
		default:
			return fmt.Errorf("%s grants access to %s", dir, sid)
		}
	}
	if !userGranted {
		return fmt.Errorf("%s does not grant the current user access", dir)
	}
	return nil
}
