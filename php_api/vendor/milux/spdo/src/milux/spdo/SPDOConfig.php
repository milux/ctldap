<?php
/**
 * Class providing configuration and factory methods for specific SPDO implementations
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

namespace milux\spdo;

abstract class SPDOConfig {

	/**
	 * @return string hostname of the database
	 */
    public abstract function getHost();

	/**
	 * @return string username for login
	 */
    public abstract function getUser();

	/**
	 * @return string password for login
	 */
    public abstract function getPassword();

	/**
	 * @return string selected database schema
	 */
    public abstract function getSchema();

	/**
	 * Pre-processes SQL strings, for example to replace prefix placeholders of table names
	 *
	 * @param $sql string unprocessed SQL
	 *
	 * @return string processed SQL
	 */
    public abstract function preProcess($sql);

	/**
	 * Returns a newly created SPDOConnection
	 *
	 * @return SPDOConnection either a SPDOConnection or a subclass with different/extended functionality
	 */
	public function newSPDOConnection() {
		return new SPDOConnection($this);
	}

	/**
	 * Returns a newly created SPDOStatement
	 *
	 * @param \PDOStatement $pdoStatement the raw PDOStatement
	 *
	 * @return SPDOStatement either a SPDOStatement or a subclass with different/extended functionality
	 */
    public function newSPDOStatement($pdoStatement) {
    	return new SPDOStatement($pdoStatement);
    }

}