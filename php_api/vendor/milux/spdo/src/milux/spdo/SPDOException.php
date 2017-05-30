<?php
/**
 * Custom SPDO exception class
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

namespace milux\spdo;

class SPDOException extends \Exception {

	/**
	 * SPDOException constructor.
	 *
	 * @param string|\PDOException $e error message or PDOException
	 * @param int $code error code
	 * @param \Exception $previous previous exception
	 */
    public function __construct($e, $code = 0, $previous = null) {
        if($e instanceof \PDOException) {
            parent::__construct($e->getMessage(), (int)$e->getCode(), $e);
            $this->code = $e->getCode();
            $this->message = $e->getMessage();
            $trace = $e->getTrace();
            $this->file = $trace[1]['file'];
            $this->line = $trace[1]['line'];
        } else {
            parent::__construct($e, $code, $previous);
        }
    }
    
}