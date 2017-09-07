<?php
/**
 * Assert required minimal PHP version 5.6.0 as announced here:
 * https://forum.churchtools.de/topic/3223/minimal-unterstützte-php-version
 */
if (!version_compare(PHP_VERSION, '5.6.0', '>=')) {
    die("Software requires PHP version 5.6.0 or newer");
}

// register composer class loader
require __DIR__ . '/vendor/autoload.php';

//add class path to include paths
set_include_path(realpath(__DIR__ . DIRECTORY_SEPARATOR . 'api_classes') . PATH_SEPARATOR . get_include_path());

/**
 * Register class loader for project classes
 *
 * @param string $c class name
 */
spl_autoload_register(function($c) {
	include strtr($c, array('\\' => DIRECTORY_SEPARATOR)) . '.php';
});

//include SPDO class
use milux\spdo\SPDO;

//read the ChurchTools configuration file and prepare database connection
$subDomain  = substr($_SERVER['SERVER_NAME'], 0, strpos($_SERVER['SERVER_NAME'], "."));
$configPath =  __DIR__ . '/sites/' . $subDomain . '/churchtools.config';
if (!file_exists($configPath)) {
	$configPath = __DIR__ . '/sites/default/churchtools.config';
}
$config = parse_ini_file($configPath);
SPDO::setConfig(new CT_SPDOConfig($config));

//get resource path parts (method parameters)
$pathInfo = explode('/', trim($_SERVER['PATH_INFO'], '/'));
//get module
$module = array_shift($pathInfo);
//get method
$method = array_shift($pathInfo);
if(empty($method)) {
	$method = strtolower($_SERVER['REQUEST_METHOD']);
}

try {
    //check the API key
    if($_REQUEST['api_key'] !== $config['api_key']) {
        throw new Exception('Invalid API key!', 403);
    }
    //check module class
    if(!class_exists($module)) {
        throw new Exception('Module "' . $module . '" not found', 404);
    }
    //create class reflection
    $reflectClass = new ReflectionClass($module);
    //check if class is callable
    if(!$reflectClass->implementsInterface('ICallable')) {
        throw new Exception('Class is no module, PATH_INFO: ' . $_SERVER['PATH_INFO'], 400);
    }
    //check method existence
    if(!$reflectClass->hasMethod($method)) {
        throw new Exception('Method not found, PATH_INFO: ' . $_SERVER['PATH_INFO'], 400);
    }
    //create method reflection
    $reflectMethod = $reflectClass->getMethod($method);
    //parse the method's DocComment
    $parser = new AnnotationParser($reflectMethod->getDocComment());
    
    //collect parameters according to information from DocComment
    $params = array();
    foreach($parser->getParamMeta() as $pName => $pMeta) {
        $src = null;
        if(isset($pMeta['Source'])) {
            $p = explode('.', $pMeta['Source'][0]);
            switch(array_shift($p)) {
                case 'POST':
                    $src = $_POST;
                    break;
                case 'GET':
                    $src = $_GET;
                    break;
                case 'PATH':
                    $src = $pathInfo;
                    break;
            }
            //scan deeper into data structure according to specified indicies
            while(count($p) > 0) {
                $subIndex = array_shift($p);
                if(isset($src[$subIndex])) {
                    $src = $src[$subIndex];
                } else {
                    $src = NULL;
                    break;
                }
            }
            //add parameterized data source to parameter array
            if(isset($src)) {
                settype($src, $pMeta['type']);
                $params[$pName] = $src;
            }
        }
    }
    
    //clear request data
    unset($pathInfo);
    $_REQUEST = $_POST = $_GET = array();

    //check if method is public and static, and number of provided parameters (res. path)
    //is greater or equal to the number of required parameters
    if(!$reflectMethod->isStatic() || !$reflectMethod->isPublic()
            || count($params) < $reflectMethod->getNumberOfRequiredParameters()) {
        throw new Exception('Method is not public static or wrong parameter number, '
	        . 'PATH_INFO: ' . $_SERVER['PATH_INFO'], 400);
    }

    $jsonExpected = strpos($_SERVER['HTTP_ACCEPT'], 'application/json') !== false;
    //wrap method call in output buffer to avoid header problems
    ob_start();
    try {
        //execute inside transaction
	    SPDO::ta(function () use ($reflectMethod, $params, $jsonExpected) {
		    $res = $reflectMethod->invokeArgs(NULL, $params);
		    if(isset($res)) {
			    if($jsonExpected || is_bool($res) || is_array($res) || (is_object($res) && $res instanceof stdClass)) {
				    header('Content-Type: application/json; charset=utf-8');
				    echo json_encode(array(
					    'status' => 'success',
					    'data' => $res
				    ));
			    } else {
				    header('Content-Type: text/html; charset=utf-8');
				    echo $res;
			    }
		    }
	    });
    } catch(Exception $e) {
        if($jsonExpected || $parser->getReturnType() === 'array') {
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(array(
            	'status' => $e->getMessage(),
                'trace' => $e->getTrace()
            ));
        } else {
            header('Content-Type: text/html; charset=utf-8');
            echo $e->getMessage();
            echo '<br />';
            echo nl2br($e->getTraceAsString());
        }
    }
    //flush buffered content
	ob_end_flush();
} catch (Exception $ex) {
    $httpCodes = array(
        400 => 'Bad Request',
        403 => 'Forbidden',
        404 => 'Not Found'
    );
    header('HTTP/1.0 ' . $ex->getCode() . ' ' . $httpCodes[$ex->getCode()]);
    header('X-Error: ' . $ex->getMessage());
}
