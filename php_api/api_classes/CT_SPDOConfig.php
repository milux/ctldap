<?php
/**
 * MySQL database configuration for ChurchTools v3.x
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

use milux\spdo\SPDOConfig;

class CT_SPDOConfig extends SPDOConfig {

	/**
	 * @var array The parsed ChurchTools configuration
	 */
	private $config = array();

	function __construct($config) {
		$this->config = $config;
	}

	public function getHost() {
		return $this->config['db_server'];
	}

	public function getUser() {
		return $this->config['db_user'];
	}

	public function getPassword() {
		return $this->config['db_password'];
	}

	public function getSchema() {
		return $this->config['db_name'];
	}

	public function preProcess($sql) {
		return strtr($sql, array('#_' => $this->config['prefix']));
	}
}