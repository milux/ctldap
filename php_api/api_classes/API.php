<?php
/**
 * ctldap PHP API class
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

use milux\spdo\SPDO;

class API implements ICallable {

	/**
	 * Checks if the user can authenticate himself in ChurchTools
	 *
	 * @param string $user     @Source(POST.user) the user name
	 * @param string $password @Source(POST.password) The password of the user
	 *
	 * @return boolean Authentication error/success
	 * @throws Exception On authentication error
	 */
    public static function authenticate($user, $password) {
        // include password_compat wrapper if supported
        $usePasswordApi = true;
	    if (!function_exists('password_hash')) {
            $hash = '$2y$04$use.any.string.for.itu8yjBBIVvIAXzFyRajcNk82tV0qIVxDK';
            $usePasswordApi = function_exists('crypt') && crypt('password', $hash) === $hash;
	    }
        $hash = SPDO::prepare("SELECT password FROM #_cdb_person WHERE LOWER(cmsuserid) = LOWER(?)")
		    ->execute($user)->cell();
	    $needsRehash = false;
	    if ($usePasswordApi && password_verify($password, $hash)) {
		    if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
			    $needsRehash = true;
		    }
	    } else if (md5(trim($password)) === $hash) {
	    	$needsRehash = true;
	    } else {
		    throw new Exception("Authentication failed for $user, password invalid!");
	    }
	    if ($usePasswordApi && $needsRehash) {
		    $newHash = password_hash($password, PASSWORD_DEFAULT);
		    SPDO::update('#_cdb_person', array('password' => $newHash),
			    'LOWER(cmsuserid) = LOWER(?)', array($user));
	    }
	    return true;
    }

	/**
	 * Returns users and groups of them
	 *
	 * @return array Users and groups of them
	 */
    public static function getUsersData() {
    	return array(
    		'users' => SPDO::query("SELECT id, cmsuserid, vorname, name, email, telefonhandy, telefonprivat, plz,
				strasse, ort FROM cdb_person WHERE cmsuserid != ''")->get(),
		    'userGroups' => SPDO::query("SELECT g.bezeichnung, gp.person_id"
			    . " FROM cdb_gruppe g"
			    . " JOIN cdb_gemeindeperson_gruppe gpg ON g.id = gpg.gruppe_id"
			    . " JOIN cdb_gemeindeperson gp ON gpg.gemeindeperson_id = gp.id"
			    . " JOIN cdb_grouptype_memberstatus gtms ON gpg.gruppenteilnehmerstatus_id = gtms.id"
			    . " WHERE g.groupstatus_id = 1 AND gtms.deleted_yn = 0 AND gtms.request_yn = 0")
			    ->group(array('person_id'))->get()
	    );
    }

	/**
	 * Return groups and their members
	 *
	 * @return array Groups and their members
	 */
    public static function getGroupsData() {
    	return array(
    		'groups' => SPDO::query("SELECT g.id, g.bezeichnung, gt.bezeichnung AS gruppentyp"
			    . " FROM cdb_gruppe g JOIN cdb_gruppentyp gt ON g.gruppentyp_id = gt.id"
			    . " WHERE g.groupstatus_id = 1 AND versteckt_yn = 0")->get(),
		    'groupMembers' =>  SPDO::query("SELECT gpg.gruppe_id, p.cmsuserid"
			    . " FROM cdb_gemeindeperson_gruppe gpg"
			    . " JOIN cdb_gemeindeperson gp ON gp.id = gpg.gemeindeperson_id"
			    . " JOIN cdb_person p ON gp.person_id = p.id"
			    . " JOIN cdb_grouptype_memberstatus gtms ON gpg.gruppenteilnehmerstatus_id = gtms.id"
			    . " WHERE cmsuserid != '' AND gtms.deleted_yn = 0 AND gtms.request_yn = 0")
			    ->group(array('gruppe_id'))->get()
	    );
    }
    
}