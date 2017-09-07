<?php
/**
 * Class for easy DB operations on a database connection
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

namespace milux\spdo;

class SPDOConnection {

    protected static $typeMap = array(
        'boolean' => \PDO::PARAM_BOOL,
        'integer' => \PDO::PARAM_INT,
        'double' => \PDO::PARAM_STR,
        'string' => \PDO::PARAM_STR,
        'NULL' => \PDO::PARAM_NULL
    );

	public static function getTypes(array $values) {
		$typeMap = self::$typeMap;
		return array_map(function ($v) use($typeMap) {
			$type = gettype($v);
			return isset($typeMap[$type]) ? $typeMap[$type] : \PDO::PARAM_STR;
		}, $values);
	}
    
    /**
     * @var \PDO the PDO object which is encapsulated by this decorator
     */
    protected $pdo = null;
	/**
	 * @var SPDOConfig the configuration object for this connection
	 */
	protected $configObject = null;
    //whether to enable insert id fetching
    protected $insertIDs = false;

	/**
	 * SPDOConnection constructor
	 *
	 * @param SPDOConfig $configObject the configuration object for this SPDOConnection
	 */
    public function __construct(SPDOConfig $configObject) {
    	$this->configObject = $configObject;
        //initialize internal PDO object
        $this->pdo = new \PDO(
                'mysql:host=' . $configObject->getHost() . ';dbname=' . $configObject->getSchema(),
                $configObject->getUser(),
                $configObject->getPassword(),
                array(
                    \PDO::MYSQL_ATTR_INIT_COMMAND => 'SET NAMES utf8',
                    \PDO::ATTR_PERSISTENT => true
                )
        );
        $this->pdo->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
    }
    
    /**
     * enables the returning of insert ids by insert() and batchInsert()
     */
    public function returnInsertIDs() {
        $this->insertIDs = true;
    }

	/**
	 * Helper to perform some function as transaction.
	 *
	 * @param callable $function The function to execute as DB transaction
	 * @param string $level The explicit transaction isolation level
	 *
	 * @return mixed Function return value
	 * @throws \Exception Re-thrown Exception if transaction fails
	 */
	public function ta(callable $function, $level = null) {
		try {
			$this->begin($level);
			$result = $function();
			$this->commit();
			return $result;
		} catch (\Exception $e) {
			$this->abort();
			throw $e;
		}
	}
    
    /**
     * Shortcut for PDO::beginTransaction();
     *
     * @param string $level The explicit transaction isolation level
     * 
     * @return bool success of transaction command
     */
    public function begin($level = null) {
        $res = $this->pdo->beginTransaction();
        if (isset($level)) {
        	$this->query('SET TRANSACTION ISOLATION LEVEL ' . $level);
        }
        return $res;
    }
    
    /**
     * PDO::commit();
     * 
     * @return bool success of transaction command
     */
    public function commit() {
        return $this->pdo->commit();
    }
    
    /**
     * shortcut for PDO::rollBack();
     * 
     * @return bool success of transaction command
     */
    public function abort() {
        return $this->pdo->rollBack();
    }
    
    /**
     * This function automatically inserts/updates data depending on a set of key columns/values.
     * If one or more row(s) with certain values in certain columns as specified by $keyColumnMap
     * exist in $table, the data of $dataColumnMap is UPDATEd to the values of the latter.
     * Otherwise, $keyColumnMap and $dataColumnMap are combined and INSERTed into $table.
     * If $dataColumnMap is omitted, this function has a "INSERT-if-not-exists" behaviour.
     * 
     * @param string $table name of the table to update or insert into
     * @param array $keyColumnMap column-value-map for key columns to test
     * @param array $dataColumnMap [optional] column-value-map for non-key columns
     * @return int|null|SPDOStatement
     */
    public function save($table, array $keyColumnMap, array $dataColumnMap = array()) {
        //assemble WHERE clause from $keyColumnMap
        $whereClause = implode(' AND ', array_map(function ($c) {
            return $c . ' = ?';
        }, array_keys($keyColumnMap)));
        //extract values from keyColumnMap for WHERE parametrization
        $whereParams = array_values($keyColumnMap);
        //check if row with specified key values exists
        $checkValue = $this->prepare('SELECT COUNT(*) FROM ' . $table . ' WHERE ' . $whereClause)
                ->execute($whereParams)->cell();
        if ($checkValue === '0') {
            //no row(s) found, perform insert with combined map
            return $this->insert($table, $dataColumnMap + $keyColumnMap);
        } else if(!empty($dataColumnMap)) {
            //row(s) found, perform update
            return $this->update($table, $dataColumnMap, $whereClause, $whereParams);
        } else {
        	return null;
        }
    }
    
    /**
     * constructs and performs an UPDATE query on a given table
     * 
     * @param string $table name of the table to update
     * @param array $columnValueMap map of column names (keys) and values to set
     * @param string $whereStmt an optional WHERE statement for the update, parameters MUST be bound with &quot;?&quot;
     * @param array $whereParams optional parameters to be passed for the WHERE statement
     * @return SPDOStatement the result statement of the UPDATE query
     */
    public function update($table, array $columnValueMap, $whereStmt = null, array $whereParams = array()) {
        //assemble set instructions
        $setInstructions = array_map(function ($c) {
            return $c . ' = ?';
        }, array_keys($columnValueMap));
        //"isolate" parameter values
        $params = array_values($columnValueMap);
        //assemble UPDATE sql query
        $sql = 'UPDATE ' . $table . ' SET ' . implode(', ', $setInstructions);
        //append WHERE query, if neccessary
        if(isset($whereStmt)) {
            $sql .=  ' WHERE ' . $whereStmt;
            //append WHERE parameters to parameter array
            $params = array_merge($params, array_values($whereParams));
        }
        //prepare, bind values and execute the UPDATE
        return $this->prepare($sql)->bindTyped($params)->execute();
    }
    
    /**
     * Constructs and performs an INSERT query on a given table
     * 
     * @param string $table Name of the table to update
     * @param array $columnValueMap Map of column names (keys) and values to insert
     * @param string $insertIdName The name of the column or DB object that is auto-incremented
     *
     * @return int|SPDOStatement Depending on the state of this SPDOConnection instance,
     * an insert ID or the statement object of the performed INSERT is returned
     */
    public function insert($table, array $columnValueMap, $insertIdName = null) {
    	//prepare, bind values and execute the INSERT
        $stmt = $this->prepare('INSERT INTO ' . $table
                . ' (' . implode(', ', array_keys($columnValueMap)) . ') '
                . 'VALUES (' . implode(', ', array_fill(0, count($columnValueMap), '?')) . ')')
            ->bindTyped($columnValueMap)->execute();
        //return execution result
        return $this->insertIDs ? $this->pdo->lastInsertId($insertIdName) : $stmt;
    }
    
    /**
     * do multiple INSERTS into specified columns<br />
     * NOTE: non-array entries in parameter 2 ($columnValuesMap)
     * are automatically expanded to arrays of suitable length!
     * 
     * @param string $table name of the INSERT target table
     * @param array $columnValuesMap map of the form "column => array(values)" or "column => value"
     * @param mixed $insertIdName [optional] parameter for PDO::lastInsertId()
     *
     * @return array|SPDOStatement depending on the state of this SPDOConnection instance,
     * an array of insert IDs or the statement object used for the INSERTs is returned
     * @throws SPDOException in case of malformed $columnValuesMap
     */
    public function batchInsert($table, array $columnValuesMap, $insertIdName = null) {
        //pre-checks of size
        $batchSize = 0;
        foreach($columnValuesMap as $a) {
            if(is_array($a)) {
                if($batchSize === 0) {
                    $batchSize = count($a);
                } else {
                    if($batchSize !== count($a)) {
                        throw new SPDOException('SPDOConnection::batchInsert() called with arrays of unequal length');
                    }
                }
            }
        }
        if($batchSize === 0) {
            throw new SPDOException('No array was found in $columnValuesMap passed to SPDOConnection::batchInsert()');
        } else {
            //expand non-array values to arrays of appropriate size
            foreach($columnValuesMap as &$a) {
                if(!is_array($a)) {
                    $a = array_fill(0, $batchSize, $a);
                }
            }
        }
        //construct and prepare insert statement
        $stmt = $this->prepare('INSERT INTO ' . $table
                . ' (' . implode(', ', array_keys($columnValuesMap)) . ') '
                . 'VALUES (' . implode(', ', array_fill(0, count($columnValuesMap), '?')) . ')');
        //bind uses for the closure to vars
        $pdoInstance = $this->pdo;
        $returnIDs = $this->insertIDs;
        //get sample data types by applying reset() an each values-array
        $types = self::getTypes(array_map('reset', $columnValuesMap));
        //prepend null to align $type array with bind counter
        array_unshift($types, null);
        $batchClosure = function () use ($stmt, $pdoInstance, $returnIDs, $insertIdName, $types) {
            $bindCounter = 1;
            //bind all values
            foreach(func_get_args() as $v) {
                $stmt->bindValue($bindCounter, $v, $types[$bindCounter]);
                $bindCounter++;
            }
            //execute insert
            $stmt->execute();
            //fetch insert id if requested
            return $returnIDs ? $pdoInstance->lastInsertId($insertIdName) : null;
        };
        //unshift the closure into the columns map
        array_unshift($columnValuesMap, $batchClosure);
        //use array_map to apply column-value-maps to the batch closure
        $insertIDs = call_user_func_array('array_map', $columnValuesMap);
        //return insert id array or statement
        return $returnIDs ? $insertIDs : $stmt;
    }
	
    /**
     * constructs and performs a DELETE query on a given table
     * 
     * @param string $table name of the table to DELETE from
     * @param string $whereClause the WHERE clause of the query
     * @param array $whereParams the parameters for the WHERE query
     *
     * @return SPDOStatement
     */
    public function delete($table, $whereClause = null, array $whereParams = array()) {
        $sql = 'DELETE FROM ' . $table;
        if(isset($whereClause)) {
            $sql .= ' WHERE ' . $whereClause;
        }
        return $this->prepare($sql)->execute($whereParams);
    }

    /**
     * PDO::query() on common PDO object
     *
     * @param string $sql
     * @return SPDOStatement|\PDOStatement
     * @throws SPDOException
     */
	public function query($sql) {
		try {
			return new SPDOStatement($this->pdo->query($this->configObject->preProcess($sql)));
		} catch(\PDOException $e) {
			throw new SPDOException($e);
		}
	}

    /**
     * PDO::exec() on common PDO object
     *
     * @param string $sql
     * @return int number of processed lines
     * @throws SPDOException
     */
	public function exec($sql) {
		try {
			return $this->pdo->exec($this->configObject->preProcess($sql));
		} catch(\PDOException $e) {
			throw new SPDOException($e);
		}
	}

    /**
     * PDO::prepare() on common PDO object
     *
     * @param string $sql
     * @param array $driver_options
     * @return SPDOStatement|\PDOStatement prepared statement
     * @throws SPDOException
     */
	public function prepare($sql, array $driver_options = array()) {
		try {
			return new SPDOStatement($this->pdo->prepare($this->configObject->preProcess($sql), $driver_options));
		} catch(\PDOException $e) {
			throw new SPDOException($e);
		}
	}

	/**
	 * Obtain the last insert ID, for a certain object or in general
	 *
	 * @param string $insertIdName The name of the column or DB object that is auto-incremented
	 * @return int The last insert ID
	 */
	public function lastInsertId($insertIdName = null) {
		return $this->pdo->lastInsertId($insertIdName);
	}
	
}