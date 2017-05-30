<?php
/**
 * Class representing parepared statements or results.
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

namespace milux\spdo;

class SPDOStatement {

	/**
	 * @var \PDOStatement
	 */
    private $statement;
    //nesting level (groups) for advanced data handling
    private $nesting = 0;
    //data structures for advanced data handling
    private $availableColumns = null;
    private $data = null;
    //marker for call to transform()
    private $transformed = false;
    //buffer for iterating with cell()
    private $line = null;
    
    public function __construct($statement) {
		$this->statement = $statement;
    }

	/**
	 * Helper function to bind an array of values to this statement
	 *
	 * @param array $toBind Parameters to bind
	 *
	 * @return SPDOStatement
	 */
	public function bindTyped(array $toBind) {
		$bindCount = 1;
		foreach(array_combine(SPDOConnection::getTypes($toBind), $toBind) as $t => $v) {
			$this->statement->bindValue($bindCount++, $v, $t);
		}
		return $this;
	}
    
	/**
	 * modified execute() which returns the underlying PDOStatement object on success,
     * thus making the execute command "chainable"
	 * 
	 * @param mixed $argument [optional] might be an array or
     * the first of an arbitrary number of parameters for binding
	 *
	 * @return SPDOStatement
	 * @throws SPDOException
	 */
    public function execute($argument = null) {
		if(isset($this->data)) {
			//reset the statement object if necessary
			$this->nesting = 0;
			$this->availableColumns = null;
			$this->data = null;
			$this->transformed = false;
			$this->line = null;
		}
        try {
			if(!isset($argument)) {
                $this->statement->execute();
            } elseif(is_array($argument)) {
                $this->statement->execute($argument);
            } else {
                $this->statement->execute(func_get_args());
            }
            return $this;
        } catch(\PDOException $e) {
            throw new SPDOException($e);
        }
    }
    
    /**
     * Ensures that data is available for processing
     */
    public function init() {
        if(!isset($this->data)) {
            //fetch data for further processing
            $this->data = $this->statement->fetchAll(\PDO::FETCH_ASSOC);
            //check for empty result
            if(!empty($this->data)) {
                //save column names as keys and values of lookup array
                $this->availableColumns = array_combine(array_keys($this->data[0]), array_keys($this->data[0]));
            }
        }
    }
    
    /**
     * Helper function to immerse into the nested structure until data dimension after group()
     * 
     * @param callback $callback the callback to apply at the innermost dimension
     * @param int $level [optional] the levels to immerse before the callback is applied,
     * defaults to the number of previous group operations
     * (e.g. the total number of array elements passed to group())
     * @return array modified copy of the internal data structure
     */
    public function immerse($callback, $level = null) {
        $this->init();
        //check for empty result
        if(empty($this->data)) {
            return $this->data;
        }
        if(!isset($level)) {
            $level = $this->nesting;
        }
        //recursive immersion closure
        $immerse = function ($data, $callback, $level) use (&$immerse) {
            if ($level === 0) {
	            /** @noinspection PhpParamsInspection */
	            return $callback($data);
            } else {
                foreach($data as &$d) {
                    $d = $immerse($d, $callback, $level - 1);
                }
                return $data;
            }
        };
        return $immerse($this->data, $callback, $level);
    }
    
    /**
     * Groups data into subarrays by given column name(s),
     * generating nested map (array) structures.
     * 
     * @param array $groups
     *
     * @return SPDOStatement
     * @throws SPDOException
     */
    public function group(array $groups) {
        $this->init();
        //check for empty result
        if(empty($this->data)) {
            return $this;
        }
        if($this->statement->columnCount() <= $this->nesting + count($groups)) {
            throw new SPDOException('Cannot do more than ' . ($this->statement->columnCount() - 1)
                    . ' group operations for ' . $this->statement->columnCount() . ' columns.'
                    . ' Use getUnique() or immerse() with custom callback retrieve flat structure!');
        }
        if($this->transformed) {
            throw new SPDOException('Cannot safely group transformed elements, transform() must be called after group!');
        }
        $cols = $this->availableColumns;
        foreach($groups as $g) {
            if(!isset($cols[$g])) {
                throw new SPDOException('Grouping column ' . $g . ' not available!');
            } else {
                unset($cols[$g]);
            }
        }
        $this->data = $this->immerse(function ($data) use ($groups) {
            //recursive closure for grouping
            $groupClosure = function($data, array $groups) use (&$groupClosure) {
                $group = array_shift($groups);
                $result = array();
                foreach($data as $rec) {
                    if(!isset($rec[$group])) {
                        throw new SPDOException($group . ': ' . json_encode($rec));
                    }
                    $key = $rec[$group];
                    if(!isset($result[$key])) {
                        $result[$key] = array();
                    }
                    unset($rec[$group]);
                    $result[$key][] = $rec;
                }
                //recursion: direcly iterate over the grouped maps with further groups
                if(!empty($groups)) {
                    foreach($result as &$d) {
                        $d = $groupClosure($d, $groups);
                    }
                }
                return $result;
            };
            return $groupClosure($data, $groups);
        });
        //correct available columns after grouping
        $this->availableColumns = $cols;
        //increase nesting level
        $this->nesting += count($groups);
        //return $this for method chaining
        return $this;
    }
    
    public function filter($callback) {
        $this->init();
        //check for empty result
        if(empty($this->data)) {
            return $this;
        }
        $this->data = $this->immerse(function ($data) use ($callback) {
            return array_values(array_filter($data, $callback));
        });
        return $this;
    }
    
    /**
     * Sets the PHP data type of specified columns
     * 
     * @param array $typeMap map of column names (keys) and types to set (values)
     * @return SPDOStatement
     * @throws SPDOException
     */
    public function cast($typeMap) {
        $this->init();
        //check for empty result
        if(empty($this->data)) {
            return $this;
        }
        foreach(array_keys($typeMap) as $c) {
            if(!isset($this->availableColumns[$c])) {
                throw new SPDOException('Casting column ' . $c . ' not available!');
            }
        }
        $this->data = $this->immerse(function ($data) use ($typeMap) {
            foreach($data as &$d) {
                foreach($typeMap as $c => $t) {
                    settype($d[$c], $t);
                }
            }
            return $data;
        });
        return $this;
    }
    
    /**
     * Applies callbacks to specified columns<br />
     * ATTENTION: Modifying a column to a non-primitive type and using it for grouping,
     * reducing, etc. can cause undefined behaviour!
     * 
     * @param array $callbackMap map of column names (keys) and callbacks to apply (values)
     * @return SPDOStatement
     * @throws SPDOException
     */
    public function mod($callbackMap) {
        $this->init();
        //check for empty result
        if(empty($this->data)) {
            return $this;
        }
        foreach(array_keys($callbackMap) as $c) {
            if(!isset($this->availableColumns[$c])) {
                throw new SPDOException('Casting column ' . $c . ' not available!');
            }
        }
        $this->data = $this->immerse(function ($data) use ($callbackMap) {
            foreach($data as &$d) {
                foreach($callbackMap as $co => $cb) {
                    $d[$co] = call_user_func($cb, $d[$co]);
                }
            }
            return $data;
        });
        return $this;
    }
    
    /**
     * Tranforms the innermost dimension elements (initially maps)
     * by tranforming them with the given callback function.<br />
     * ATTENTION: group(), getObjects() and getUnique(true) cannot be used after this operation!
     * 
     * @param callback $callback callback accepting exactly one element
     * @return SPDOStatement
     */
    public function transform($callback) {
        $this->transformed = true;
        $this->data = $this->immerse(function ($data) use ($callback) {
            foreach($data as &$d) {
                $d = $callback($d);
            }
            return $data;
        });
        return $this;
    }
    
    /**
     * get next cell of data set
     * 
     * @param bool $reset setting this parameter to true will reset the array pointers
     * (required for first call)
     * @return mixed
     * @throws SPDOException
     */
    public function cell($reset = false) {
        if($this->nesting > 0) {
            throw new SPDOException('Cannot interate over cells after group()!');
        }
        if($this->transformed) {
            throw new SPDOException('Cannot safely interate over cells after transform()!');
        }
        $this->init();
        if($reset) {
            reset($this->data);
        }
        //iteration logic
        if(!isset($this->line) || $reset) {
            //if line is not set, use each() over data to get next line
            $eachOut = each($this->data);
            if($eachOut === false) {
                return false;
            } else {
                $this->line = $eachOut[1];
                reset($this->line);
            }
        }
        $eachIn = each($this->line);
        if($eachIn === false) {
            //set $this->line to null and do one-step-recursion to get next cell
            $this->line = null;
            return $this->cell();
        } else {
            //return cell
            return $eachIn[1];
        }
    }
    
    /**
     * Returns the manipulated data as hold in this statement.
     * The innermost dimension usually consists of maps (assoc. arrays).
     * This is different if transform() was called on this statement with non-array callback return type.
     * 
     * @param bool $reduce whether to reduce one-element-arrays to their value
     * @return array manipulated data as hold in this statement object
     */
    public function get($reduce = true) {
        $this->init();
        if(!$this->transformed && $this->statement->columnCount() === $this->nesting + 1 && $reduce) {
            return $this->immerse(function ($data) {
                //reduce 1-element-maps to their value
                foreach($data as &$cell) {
                    $cell = reset($cell);
                }
                return $data;
            });
        } else {
            return $this->data;
        }
    }
    
    public function getUnique($reduce = true) {
        if(!$this->transformed && $this->statement->columnCount() === $this->nesting + 1 && $reduce) {
            return $this->immerse(function ($data) {
                //reduce 1-element-maps inside 1-element-arrays to their value
                if(count($data) === 1) {
                    return reset(reset($data));
                } else {
                    throw new SPDOException('Unique fetch failed, map with more than one element was found!');
                }
            });
        } else {
            //reduce 1-element-arrays to their value
            return $this->immerse(function ($data) {
                if(count($data) === 1) {
                    return reset($data);
                } else {
                    throw new SPDOException('Unique fetch failed, map with more than one element found!');
                }
            });
        }
    }
    
    public function getObjects() {
        if($this->transformed) {
            throw new SPDOException('Cannot safely cast transformed elements, use transform() call for object casting!');
        }
        //simply cast to objects
        return $this->immerse(function ($data) {
            foreach($data as &$d) {
                $d = (object)$d;
            }
            return $data;
        });
    }
    
    public function getFunc($callback) {
        return $this->immerse(function ($data) use ($callback) {
            foreach($data as &$d) {
                $d = $callback($d);
            }
            return $data;
        });
    }

	/**
	 * Passes the parameter binding to the underlying statement
	 *
	 * @param string $parameter The number/name of the bind parameter
	 * @param mixed $value The value that is bound
	 * @param int $data_type The PDO data type
	 */
    public function bindValue($parameter, $value, $data_type) {
    	$this->statement->bindValue($parameter, $value, $data_type);
    }

}
