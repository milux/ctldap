<?php
/**
 * Class for parsing parameters in DocComment of php methods
 *
 * @author Michael Lux <michi.lux@gmail.com>
 * @copyright Copyright (c) 2017 Michael Lux
 * @license GNU/GPLv3
 */

class AnnotationParser {
    
    private $annotations = array();
    private $paramAnnotations = null;
    
    public function __construct($docComment) {
        $token = strtok($docComment, "\n");
        while($token !== false) {
            $matches = array();
            if(preg_match('/^\s*\*?\s*@([a-zA-Z]+)\s+(.*)/', $token, $matches) > 0) {
                if(!isset($this->annotations[$matches[1]])) {
                    $this->annotations[$matches[1]] = array();
                }
                $this->annotations[$matches[1]][] = $matches[2];
            }
            $token = strtok("\n");
        }
    }
    
    public function getAnnotations() {
        return $this->annotations;
    }
    
    public function getParamMeta() {
        if(!isset($this->paramAnnotations)) {
            $this->paramAnnotations = array();
            if(isset($this->annotations['param'])) {
                foreach($this->annotations['param'] as $pa) {
                    $tokens = array();
                    //read parameter name and type
                    if(preg_match('/(\S+)\s+\$(\S+)\s+(.*)/', $pa, $tokens) > 0) {
                        $paramName = $tokens[2];
                        $this->paramAnnotations[$paramName] = array(
                            'type' => $tokens[1]
                        );
                        $nas = array();
                        //find nested annotations of the form @AnnotationName(content)
                        preg_match_all('/@([a-zA-Z]+)\((.+?)\)/', $tokens[3], $nas, PREG_SET_ORDER);
                        foreach($nas as $na) {
                            if(!isset($this->paramAnnotations[$paramName][$na[1]])) {
                                $this->paramAnnotations[$paramName][$na[1]] = array();
                            }
                            $this->paramAnnotations[$paramName][$na[1]][] = $na[2];
                        }
                    }
                }
            }
        }
        return $this->paramAnnotations;
    }
    
    public function getReturnType() {
        if(isset($this->annotations['return'])) {
            $typeAndDesc = explode(' ', $this->annotations['return'][0], 2);
            if(!empty($typeAndDesc)) {
                return $typeAndDesc[0];
            }
        }
    }
    
}
